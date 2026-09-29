const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = 8080;
const HEARTBEAT_INTERVAL = 25000; // 25s < typical nginx proxy_read_timeout (60s)
const ROOM_EMPTY_TTL = 5 * 60 * 1000; // 5min before deleting empty room

// roomId -> {
//   name,
//   users: Map<WebSocket, string>,
//   messages: [],
//   _emptyTimer: Timeout|null
// }
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

function broadcastRoomList() {
  const data = {
    type: "rooms",
    rooms: listRooms()
  };

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
  broadcastRoomList();

  // Auto-delete if nobody joins within TTL
  room._emptyTimer = setTimeout(() => {
    const currentRoom = rooms.get(id);
    if (currentRoom && currentRoom.users.size === 0) {
      deleteRoom(id);
    }
  }, ROOM_EMPTY_TTL);

  return room;
}

function deleteRoom(id) {
  const room = rooms.get(id);
  if (room && room._emptyTimer) {
    clearTimeout(room._emptyTimer);
  }
  rooms.delete(id);
  broadcastRoomList();
}

function leaveRoom(socket) {
  const roomId = socket.roomId;

  if (!roomId) {
    return;
  }

  const room = rooms.get(roomId);

  if (!room) {
    socket.roomId = null;
    return;
  }

  const user = room.users.get(socket);

  room.users.delete(socket);

  if (user) {
    broadcast(room, {
      type: "system",
      text: `${user} est parti.`
    });
  }

  socket.roomId = null;
  socket.user = null;

  // Le salon disparaît dès qu'il est vide.
  if (room.users.size === 0) {
    // Clear the empty-room timer since we're deleting now
    if (room._emptyTimer) {
      clearTimeout(room._emptyTimer);
      room._emptyTimer = null;
    }
    deleteRoom(roomId);
    return;
  }

  // Restart empty-room timer
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


// -------------------------------------------------------------------
// HTTP : sert simplement index.html
// -------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    const file = path.join(__dirname, "index.html");

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Erreur serveur");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });

      res.end(data);
    });

    return;
  }

  res.writeHead(404);
  res.end("Not found");
});


// -------------------------------------------------------------------
// WebSocket
// -------------------------------------------------------------------

const wss = new WebSocket.Server({ server });

// Heartbeat interval to detect dead connections behind reverse proxy
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) {
      return socket.terminate(); // triggers socket.on("close")
    }
    socket.isAlive = false;
    socket.ping();
  });
}, HEARTBEAT_INTERVAL);

// Clean up interval on server close
process.on("SIGINT", () => {
  clearInterval(heartbeatInterval);
  process.exit(0);
});
process.on("SIGTERM", () => {
  clearInterval(heartbeatInterval);
  process.exit(0);
});

wss.on("connection", (socket, req) => {
  // Track real client IP behind reverse proxy
  socket.clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
                 || req.socket.remoteAddress;

  // Heartbeat setup
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  // Envoyer immédiatement la liste des salons existants.
  send(socket, {
    type: "rooms",
    rooms: listRooms()
  });


  socket.on("message", (raw) => {
    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }


    // ---------------------------------------------------------------
    // Créer un salon
    // ---------------------------------------------------------------

    if (data.type === "create_room") {
      const roomId = String(data.room || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 30);

      if (!roomId) {
        send(socket, {
          type: "error",
          text: "Nom de salon invalide."
        });
        return;
      }

      if (rooms.has(roomId)) {
        send(socket, {
          type: "error",
          text: "Ce salon existe déjà."
        });
        return;
      }

      createRoom(roomId);

      send(socket, {
        type: "room_created",
        room: roomId
      });

      return;
    }


    // ---------------------------------------------------------------
    // Rejoindre un salon
    // ---------------------------------------------------------------

    if (data.type === "join_room") {
      const roomId = String(data.room || "").trim();
      const name = String(data.name || "Anonyme")
        .trim()
        .slice(0, 30);

      if (!name || !roomId) {
        return;
      }

      const room = rooms.get(roomId);

      if (!room) {
        send(socket, {
          type: "error",
          text: "Ce salon n'existe plus."
        });
        return;
      }

      // Si l'utilisateur était déjà dans un salon,
      // on le fait d'abord sortir.
      leaveRoom(socket);

      socket.user = name;
      socket.roomId = roomId;

      room.users.set(socket, name);

      // Envoyer l'historique temporaire du salon.
      send(socket, {
        type: "room_joined",
        room: roomId,
        messages: room.messages
      });

      broadcast(room, {
        type: "system",
        text: `${name} est arrivé.`
      });

      broadcastUsers(room);

      return;
    }


    // ---------------------------------------------------------------
    // Quitter un salon
    // ---------------------------------------------------------------

    if (data.type === "leave_room") {
      leaveRoom(socket);
      return;
    }


    // ---------------------------------------------------------------
    // Message
    // ---------------------------------------------------------------

    if (data.type === "message") {
      const roomId = socket.roomId;

      if (!roomId || !socket.user) {
        return;
      }

      const room = rooms.get(roomId);

      if (!room) {
        return;
      }

      const text = String(data.text || "")
        .trim()
        .slice(0, 500);

      if (!text) {
        return;
      }

      const message = {
        user: socket.user,
        text,
        time: Date.now()
      };

      room.messages.push(message);

      // Historique limité à 100 messages.
      if (room.messages.length > 100) {
        room.messages.shift();
      }

      broadcast(room, {
        type: "message",
        message
      });

      return;
    }
  });


  // Déconnexion du navigateur.
  socket.on("close", () => {
    leaveRoom(socket);
  });
});


server.listen(PORT, () => {
  console.log(`Chat disponible sur http://localhost:${PORT}`);
});