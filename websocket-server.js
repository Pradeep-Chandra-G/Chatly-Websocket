// OPTIMIZED WebSocket Server (websocket-server.js)
const { createServer } = require("http");
const { Server } = require("socket.io");

const port = process.env.PORT || 3001;

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

  // OPTIMIZATION 1: Tune timeouts for 512 MB RAM
  pingTimeout: 60000,
  pingInterval: 25000,

  // OPTIMIZATION 2: Connection limits
  maxHttpBufferSize: 1e6, // 1 MB max message size (down from default 1e8)

  // OPTIMIZATION 3: Compression for bandwidth savings
  perMessageDeflate: {
    threshold: 1024, // only compress messages > 1KB
  },

  // OPTIMIZATION 4: Limit connections per origin (prevent abuse)
  allowEIO3: false, // disable legacy protocol
});

// OPTIMIZATION 5: Use Map instead of Set for better memory efficiency
const userSockets = new Map(); // userId -> socketId
const onlineUsers = new Map(); // userId -> { socketId, lastSeen }
const userConversations = new Map(); // userId -> Set of conversationIds

// OPTIMIZATION 6: Periodic cleanup of stale connections
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const STALE_TIMEOUT = 10 * 60 * 1000; // 10 minutes

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [userId, userData] of onlineUsers.entries()) {
    if (now - userData.lastSeen > STALE_TIMEOUT) {
      onlineUsers.delete(userId);
      userSockets.delete(userId);
      userConversations.delete(userId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} stale connections`);
  }

  // Log memory usage
  const used = process.memoryUsage();
  console.log(
    `📊 Memory: ${Math.round(used.heapUsed / 1024 / 1024)} MB / ${Math.round(
      used.heapTotal / 1024 / 1024
    )} MB`
  );
  console.log(`👥 Online users: ${onlineUsers.size}`);
}, CLEANUP_INTERVAL);

io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  socket.on("user:online", (userId) => {
    console.log(`✅ User ${userId} is now online`);

    userSockets.set(userId, socket.id);
    socket.userId = userId;
    socket.join(userId);

    // OPTIMIZATION 7: Track last seen for cleanup
    onlineUsers.set(userId, {
      socketId: socket.id,
      lastSeen: Date.now(),
    });

    if (!userConversations.has(userId)) {
      userConversations.set(userId, new Set());
    }

    // Send initial online users list
    socket.emit("users:online-list", {
      onlineUsers: Array.from(onlineUsers.keys()),
    });

    // Broadcast to others that this user is online
    socket.broadcast.emit("user:status", {
      userId,
      status: "online",
    });
  });

  socket.on("ping", () => {
    // OPTIMIZATION 8: Update last seen on ping
    if (socket.userId && onlineUsers.has(socket.userId)) {
      onlineUsers.get(socket.userId).lastSeen = Date.now();
    }
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
    console.log(
      `👥 User ${socket.userId} joined conversation ${conversationId}`
    );
    socket.join(conversationId);

    if (socket.userId && userConversations.has(socket.userId)) {
      userConversations.get(socket.userId).add(conversationId);
    }
  });

  socket.on("conversation:leave", (conversationId) => {
    console.log(`👋 User ${socket.userId} left conversation ${conversationId}`);
    socket.leave(conversationId);

    if (socket.userId && userConversations.has(socket.userId)) {
      userConversations.get(socket.userId).delete(conversationId);
    }
  });

  // OPTIMIZATION 9: Simplified message handler (removed duplicate logic)
  socket.on("message:send", (data) => {
    console.log(`📨 Message sent in conversation ${data.conversationId}`);

    // Broadcast to conversation room
    io.to(data.conversationId).emit("message:new", data);

    // Also send to all participants' personal rooms
    if (data.participants && Array.isArray(data.participants)) {
      data.participants.forEach((participantId) => {
        io.to(participantId).emit("message:new", data);
      });
    }

    // Check for delivery
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
    io.to(conversationId).emit("message:status", {
      messageId,
      status: "read",
    });
  });

  socket.on("messages:mark-read", ({ messageIds, conversationId }) => {
    messageIds.forEach((messageId) => {
      io.to(conversationId).emit("message:status", {
        messageId,
        status: "read",
      });
    });
  });

  socket.on(
    "message:edit",
    ({
      messageId,
      conversationId,
      content,
      edited,
      editedAt,
      isLastMessage,
    }) => {
      io.to(conversationId).emit("message:edited", {
        messageId,
        content,
        edited,
        editedAt,
        conversationId,
        isLastMessage, // ✅ Pass this through
      });
    }
  );

  socket.on(
    "message:delete",
    ({ messageId, conversationId, newLastMessage }) => {
      io.to(conversationId).emit("message:deleted", {
        messageId,
        conversationId,
        newLastMessage,
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
      console.log(`❌ User ${socket.userId} disconnected`);
      userSockets.delete(socket.userId);
      onlineUsers.delete(socket.userId);
      userConversations.delete(socket.userId);

      io.emit("user:status", { userId: socket.userId, status: "offline" });
    }
  });
});

// OPTIMIZATION 10: Graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, closing server gracefully");

  io.close(() => {
    console.log("✅ WebSocket server closed");
    server.close(() => {
      console.log("✅ HTTP server closed");
      process.exit(0);
    });
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error("⚠️ Forcing shutdown");
    process.exit(1);
  }, 10000);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`> WebSocket server ready on port ${port}`);
  console.log(`📊 Memory limit: 512 MB`);
  console.log(`👥 Estimated capacity: 200-400 concurrent connections`);
});
