const WebSocket = require("ws");
const crypto = require("crypto");
const {AiBot,BOT_NAME} = require("./ai-bot.js");

const HEARTBEAT_INTERVAL = 25000;
const ROOM_EMPTY_TTL = 5 * 60 * 1000;
const HISTORY_LIMIT = 100;
const MAX_ROOM_NAME = 30;

/* The shared, always-on room. It is created once at boot and outlives everyone:
   it is a botMode "shared" room, so leaving it empties it for a while and lets
   it come back, instead of killing the bot. */
const SHARED_AI_ROOM = process.env.AI_ROOM || "ai";
const ENABLE_AI = process.env.ENABLE_AI !== "false";

const rooms = new Map();

function send(socket, data) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  for (const socket of room.users.keys()) {
    send(socket, data);
  }
}

/* A hidden room belongs to one browser. It is absent from the directory, and
   joined only by the session that created it — anyone who guesses the name gets
   a refusal rather than someone else's conversation. */
function listRooms(socket) {
  return [...rooms.entries()]
    .filter(([, room]) => !room.hidden || room.ownerSession === socket.sessionId)
    .map(([id, room]) => ({
      id,
      name: room.name,
      users: countHumans(room),
      ai: Boolean(room.bot),
      mine: room.ownerSession === socket.sessionId
    }));
}

function broadcastRoomList(wss) {
  /* The list is per-socket, not global: a hidden room is in one client's
     directory and nobody else's, so a single broadcast payload would defeat
     the whole point of hiding it. */
  for (const socket of wss.clients) {
    send(socket, { type: "rooms", rooms: listRooms(socket) });
  }
}

/* The bot does not count as a participant: a room holding only its AI is a
   room with nobody in it, and that is precisely the state that kills it. */
function countHumans(room) {
  return room.users.size;
}

function hasHumans(room) {
  return room.users.size > 0;
}

function normalizeRoomId(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, MAX_ROOM_NAME);
}

function createRoom(id, { hidden = false, ownerSession = null, botMode = null } = {}) {
  const room = {
    id,
    name: id,
    hidden,
    ownerSession,
    botMode,
    bot: null,
    users: new Map(),
    messages: [],
    _emptyTimer: null
  };
if (botMode) {
    /* One AiBot per room. Same model, same Ollama process, separate history —
       this is what lets a public room and three private conversations share a
       single loaded model without mixing their turns. */
    room.bot = new AiBot({ name: BOT_NAME, useDocs: true, strictDocs: false });
}
  rooms.set(id, room);
  return room;
}

/* Kill the AI and erase everything it knew. Called for the private rooms when
   the user walks out: the next visit to a room of the same name is a fresh
   conversation, not a transcript of one the user has moved on from. */
function destroyRoom(id, reason) {
  const room = rooms.get(id);
  if (!room) return false;
  if (room._emptyTimer) {
    clearTimeout(room._emptyTimer);
  }
  if (room.bot) {
    broadcast(room, { type: "system", text: "L'IA ferme la session." });
    room.bot.destroy();
    room.bot = null;
  }
  room.messages = [];
  room.users.clear();
  rooms.delete(id);
  console.log(`[Chat] Room #${id} destroyed${reason ? ` (${reason})` : ""}`);
  return true;
}

/* What happens once the last person is out. A shared room only rests — a brief
   reload must not announce that the room has gone. A private 1-to-1 room dies
   at once, because leaving it is an explicit "we are done here". */
function onRoomEmptied(roomId, wss) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.botMode === "shared") {
    if (room._emptyTimer) clearTimeout(room._emptyTimer);
    room._emptyTimer = setTimeout(() => {
      const current = rooms.get(roomId);
      if (current && !hasHumans(current)) {
        destroyRoom(roomId, "empty");
        broadcastRoomList(wss);
      }
    }, ROOM_EMPTY_TTL);
    return;
  }
  destroyRoom(roomId, "last user left");
  broadcastRoomList(wss);
}

function leaveRoom(socket, wss) {
  const roomId = socket.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  socket.roomId = null;
  const user = socket.user;
  socket.user = null;
  if (!room) return;

  room.users.delete(socket);

  if (user) {
    broadcast(room, { type: "system", text: `${user} est parti.` });
  }

  if (!hasHumans(room)) {
    onRoomEmptied(roomId, wss);
    /* The client that just left needs to be told explicitly: it is not in the
       room any more, so it will not receive the room's own broadcasts, and
       "quit" has to put its window back in the directory. */
    send(socket, { type: "room_left", room: roomId });
    broadcastRoomList(wss);
    return;
  }

  // Room is alive again: cancel a pending expiry.
  if (room._emptyTimer) {
    clearTimeout(room._emptyTimer);
    room._emptyTimer = null;
  }

  broadcastUsers(room);
  broadcastRoomList(wss);
}

function broadcastUsers(room) {
  broadcast(room, {
    type: "users",
    users: [...room.users.values()],
    ai: Boolean(room.bot)
  });
}

/* The AI speaks like any other participant, through the same message event, so
   no client has to grow a special case to display it. */
async function letAiAnswer(room, text) {
  if (!room.bot) return;
  let result = null;
  try {
    result = await room.bot.ask(text);
  } catch (error) {
    console.error(`[Chat] Ollama error in #${room.id}:`, error.message);
    broadcast(room, { type: "message", message: { user: BOT_NAME, text: "Désolé, j'ai eu un problème pour répondre.", time: Date.now() } });
    return;
  }
  /* The room can be gone by now: the user quit while the model was thinking.
     The answer is dropped rather than posted to whoever came next. */
  if (!result || !result.answer || !rooms.has(room.id) || !room.bot) return;
  const message = { user: BOT_NAME, text: result.answer, time: Date.now(), sources: result.sources };
  room.messages.push(message);
  if (room.messages.length > HISTORY_LIMIT) room.messages.shift();
  broadcast(room, { type: "message", message });
}

function attachChatServer(server) {
  const wss = new WebSocket.Server({ server });

  if (ENABLE_AI) {
    createRoom(SHARED_AI_ROOM, { botMode: "shared" });
    console.log(`[Chat] Room #${SHARED_AI_ROOM} opened with ${BOT_NAME}`);
  }

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((socket) => {
      if (socket.isAlive === false) {
        return socket.terminate();
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, HEARTBEAT_INTERVAL);

  const clearHeartbeat = () => clearInterval(heartbeatInterval);
  process.on("SIGINT", clearHeartbeat);
  process.on("SIGTERM", clearHeartbeat);

  wss.on("connection", (socket, req) => {
    socket.clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
      || req.socket.remoteAddress;
    /* A stable identity for this browser, so a hidden room stays the user's
       across a reload without asking for a password. */
    socket.sessionId = crypto.randomBytes(16).toString("hex");
    socket.roomId = null;
    socket.user = null;

    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });

    send(socket, { type: "hello", sessionId: socket.sessionId });
    send(socket, { type: "rooms", rooms: listRooms(socket) });

    socket.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }

      if (data.type === "create_room") {
        const roomId = normalizeRoomId(data.room);
        const hidden = Boolean(data.hidden);

        if (!roomId) {
          send(socket, { type: "error", text: "Nom de salon invalide." });
          return;
        }

        if (rooms.has(roomId)) {
          send(socket, { type: "error", text: "Ce salon existe déjà." });
          return;
        }

        /* `hidden` is the private room: not listed, owned by this session, and
           it comes with its own AI that lives and dies with the session. */
        createRoom(roomId, {
          hidden,
          ownerSession: hidden ? socket.sessionId : null,
          botMode: hidden ? "solo" : null
        });
        send(socket, {
          type: "room_created",
          room: roomId,
          hidden,
          ai: hidden
        });
        broadcastRoomList(wss);
        return;
      }

      if (data.type === "join_room") {
        const roomId = normalizeRoomId(data.room);
        const name = String(data.name || "Anonyme")
          .trim()
          .slice(0, 30);

        if (!name || !roomId) return;

        const room = rooms.get(roomId);
        if (!room) {
          send(socket, { type: "error", text: "Ce salon n'existe plus. Créez-le avec le bouton Create." });
          send(socket, { type: "rooms", rooms: listRooms(socket) });
          return;
        }

        if (room.hidden && room.ownerSession !== socket.sessionId) {
          send(socket, { type: "error", text: "Ce salon est privé." });
          return;
        }

        leaveRoom(socket, wss);

        socket.user = name;
        socket.roomId = roomId;
        // A join cancels a pending empty-room expiry.
        if (room._emptyTimer) {
          clearTimeout(room._emptyTimer);
          room._emptyTimer = null;
        }
        room.users.set(socket, name);

        send(socket, {
          type: "room_joined",
          room: roomId,
          messages: room.messages,
          hidden: room.hidden,
          mine: room.ownerSession === socket.sessionId,
          ai: Boolean(room.bot)
        });

        broadcast(room, { type: "system", text: `${name} est arrivé.` });
        broadcastUsers(room);
        broadcastRoomList(wss);

        /* The AI greets once, and only the first time in the room's life — a
           greeting repeated on every reconnection is noise. */
        if (room.bot && room.messages.length === 0 && hasHumans(room)) {
          const greeting = room.hidden
            ? "Session ouverte. Pose ta question, je reste tant que tu es là."
            : "Salut !";
          room.bot.seed(greeting);
          room.messages.push({
            user: BOT_NAME,
            text: greeting,
            time: Date.now()
          });
          broadcast(room, {
            type: "message",
            message: room.messages[room.messages.length - 1]
          });
        }
        return;
      }

      if (data.type === "leave_room") {
        leaveRoom(socket, wss);
        send(socket, { type: "rooms", rooms: listRooms(socket) });
        return;
      }

      if (data.type === "message") {
        const roomId = socket.roomId;
        if (!roomId || !socket.user) return;

        const room = rooms.get(roomId);
        if (!room) return;

        const text = String(data.text || "").trim().slice(0, 500);
        if (!text) return;

        const message = { user: socket.user, text, time: Date.now() };
        room.messages.push(message);
        if (room.messages.length > HISTORY_LIMIT) room.messages.shift();

        broadcast(room, { type: "message", message });
        // Not awaited: the client is free again the instant its own message is
        // echoed back, while the model takes its time.
        letAiAnswer(room, text);
        return;
      }
    });

    socket.on("close", () => {
      leaveRoom(socket, wss);
    });
  });

  return wss;
}

module.exports = { attachChatServer };
