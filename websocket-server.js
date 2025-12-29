const { createServer } = require("http");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");

const port = process.env.PORT || 3001;

// Minimal HTTP server just for Socket.IO
const server = createServer((req, res) => {
  res.writeHead(200);
  res.end("WebSocket Server Running");
});

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  path: "/socket.io/",
  pingTimeout: 60000,
  pingInterval: 25000,
});

const userSockets = new Map();
const onlineUsers = new Set();
const userConversations = new Map();

io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  socket.on("user:online", (userId) => {
    console.log(`✅ User ${userId} is now online`);
    userSockets.set(userId, socket.id);
    socket.userId = userId;
    socket.join(userId);
    onlineUsers.add(userId);

    if (!userConversations.has(userId)) {
      userConversations.set(userId, new Set());
    }

    socket.emit("users:online-list", {
      onlineUsers: Array.from(onlineUsers),
    });

    socket.broadcast.emit("user:status", {
      userId,
      status: "online",
    });
  });

  socket.on("ping", () => {
    socket.emit("pong");
  });

  socket.on("typing:start", ({ conversationId, userId }) => {
    socket.to(conversationId).emit("user:typing", { userId, conversationId });
  });

  socket.on("typing:stop", ({ conversationId, userId }) => {
    socket
      .to(conversationId)
      .emit("user:stop-typing", { userId, conversationId });
  });

  socket.on("conversation:join", (conversationId) => {
    socket.join(conversationId);
    if (socket.userId && userConversations.has(socket.userId)) {
      userConversations.get(socket.userId).add(conversationId);
    }
  });

  socket.on("conversation:leave", (conversationId) => {
    socket.leave(conversationId);
    if (socket.userId && userConversations.has(socket.userId)) {
      userConversations.get(socket.userId).delete(conversationId);
    }
  });

  socket.on("message:send", (data) => {
    io.to(data.conversationId).emit("message:new", data);
    const conversationSockets = io.sockets.adapter.rooms.get(
      data.conversationId
    );
    if (conversationSockets && conversationSockets.size > 1) {
      setTimeout(() => {
        io.to(data.conversationId).emit("message:status", {
          messageId: data._id,
          status: "delivered",
        });
      }, 100);
    }
  });

  socket.on("message:delivered", ({ messageId, conversationId }) => {
    io.to(conversationId).emit("message:status", {
      messageId,
      status: "delivered",
    });
  });

  socket.on("message:read", ({ messageId, conversationId }) => {
    io.to(conversationId).emit("message:status", { messageId, status: "read" });
  });

  socket.on(
    "message:edit",
    ({ messageId, conversationId, content, edited, editedAt }) => {
      io.to(conversationId).emit("message:edited", {
        messageId,
        content,
        edited,
        editedAt,
      });
    }
  );

  socket.on("call:initiate", ({ callId, receiverId, type, offer }) => {
    const receiverSocket = userSockets.get(receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit("call:incoming", {
        callId,
        callerId: socket.userId,
        type,
        offer,
      });
    }
  });

  socket.on("call:answer", ({ callId, callerId, answer }) => {
    const callerSocket = userSockets.get(callerId);
    if (callerSocket) {
      io.to(callerSocket).emit("call:answered", { callId, answer });
    }
  });

  socket.on("call:ice-candidate", ({ targetId, candidate }) => {
    const targetSocket = userSockets.get(targetId);
    if (targetSocket) {
      io.to(targetSocket).emit("call:ice-candidate", {
        senderId: socket.userId,
        candidate,
      });
    }
  });

  socket.on("call:reject", ({ callId, callerId }) => {
    const callerSocket = userSockets.get(callerId);
    if (callerSocket) {
      io.to(callerSocket).emit("call:rejected", { callId });
    }
  });

  socket.on("call:end", ({ callId, targetId }) => {
    const targetSocket = userSockets.get(targetId);
    if (targetSocket) {
      io.to(targetSocket).emit("call:ended", { callId });
    }
  });

  socket.on("message:reaction", ({ messageId, conversationId, reactions }) => {
    io.to(conversationId).emit("message:reaction-update", {
      messageId,
      reactions,
    });
  });

  socket.on("disconnect", () => {
    if (socket.userId) {
      userSockets.delete(socket.userId);
      onlineUsers.delete(socket.userId);
      userConversations.delete(socket.userId);
      io.emit("user:status", { userId: socket.userId, status: "offline" });
    }
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`> WebSocket server ready on port ${port}`);
});
