const WebSocket = require("ws");

const HEARTBEAT_INTERVAL = 25000;
const ROOM_EMPTY_TTL = 5 * 60 * 1000;

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

function listRooms() {
  return [...rooms.entries()].map(([id, room]) => ({
    id,
    name: room.name,
    users: room.users.size
  }));
}

function broadcastRoomList(wss) {
  const data = { type: "rooms", rooms: listRooms() };
  for (const socket of wss.clients) {
    send(socket, data);
  }
}

function createRoom(id) {
  const room = {
    name: id,
    users: new Map(),
    messages: [],
    _emptyTimer: null
  };
  rooms.set(id, room);
  return room;
}

function deleteRoom(id) {
  const room = rooms.get(id);
  if (room && room._emptyTimer) {
    clearTimeout(room._emptyTimer);
  }
  rooms.delete(id);
}

function leaveRoom(socket) {
  const roomId = socket.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) {
    socket.roomId = null;
    return;
  }

  const user = room.users.get(socket);
  room.users.delete(socket);

  if (user) {
    broadcast(room, { type: "system", text: `${user} est parti.` });
  }

  socket.roomId = null;
  socket.user = null;

  if (room.users.size === 0) {
    if (room._emptyTimer) {
      clearTimeout(room._emptyTimer);
      room._emptyTimer = null;
    }
    deleteRoom(roomId);
    return;
  }

  room._emptyTimer = setTimeout(() => {
    const currentRoom = rooms.get(roomId);
    if (currentRoom && currentRoom.users.size === 0) {
      deleteRoom(roomId);
    }
  }, ROOM_EMPTY_TTL);

  broadcastUsers(room);
}

function broadcastUsers(room) {
  broadcast(room, {
    type: "users",
    users: [...room.users.values()]
  });
}

function attachChatServer(server) {
  const wss = new WebSocket.Server({ server });

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((socket) => {
      if (socket.isAlive === false) {
        return socket.terminate();
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, HEARTBEAT_INTERVAL);

  process.on("SIGINT", () => {
    clearInterval(heartbeatInterval);
  });
  process.on("SIGTERM", () => {
    clearInterval(heartbeatInterval);
  });

  wss.on("connection", (socket, req) => {
    socket.clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
      || req.socket.remoteAddress;

    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });

    send(socket, { type: "rooms", rooms: listRooms() });

    socket.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }

      if (data.type === "create_room") {
        const roomId = String(data.room || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "")
          .slice(0, 30);

        if (!roomId) {
          send(socket, { type: "error", text: "Nom de salon invalide." });
          return;
        }

        if (rooms.has(roomId)) {
          send(socket, { type: "error", text: "Ce salon existe déjà." });
          return;
        }

        createRoom(roomId);
        send(socket, { type: "room_created", room: roomId });
        broadcastRoomList(wss);
        return;
      }

      if (data.type === "join_room") {
        const roomId = String(data.room || "").trim();
        const name = String(data.name || "Anonyme")
          .trim()
          .slice(0, 30);

        if (!name || !roomId) return;

        const room = rooms.get(roomId);
        if (!room) {
          send(socket, { type: "error", text: "Ce salon n'existe plus." });
          return;
        }

        leaveRoom(socket);

        socket.user = name;
        socket.roomId = roomId;
        room.users.set(socket, name);

        send(socket, {
          type: "room_joined",
          room: roomId,
          messages: room.messages
        });

        broadcast(room, { type: "system", text: `${name} est arrivé.` });
        broadcastUsers(room);
        return;
      }

      if (data.type === "leave_room") {
        leaveRoom(socket);
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
        if (room.messages.length > 100) room.messages.shift();

        broadcast(room, { type: "message", message });
        return;
      }
    });

    socket.on("close", () => {
      leaveRoom(socket);
    });
  });

  return wss;
}

module.exports = { attachChatServer };