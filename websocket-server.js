// FIXED WebSocket Server (websocket-server-fixed.js)
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
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: {
    threshold: 1024,
  },
  allowEIO3: false,
});

const userSockets = new Map(); // userId -> socketId
const onlineUsers = new Map(); // userId -> { socketId, lastSeen }
const userConversations = new Map(); // userId -> Set of conversationIds

// ✅ NEW: Track pending messages for offline users
const pendingDeliveries = new Map(); // conversationId -> Set of messageIds

const CLEANUP_INTERVAL = 5 * 60 * 1000;
const STALE_TIMEOUT = 10 * 60 * 1000;

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

    // ✅ FIX: Process pending deliveries for this user
    processPendingDeliveries(userId);
  });

  socket.on("ping", () => {
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

    // ✅ FIX: Check for pending deliveries when joining conversation
    checkPendingDeliveriesForConversation(conversationId, socket.userId);
  });

  socket.on("conversation:leave", (conversationId) => {
    console.log(`👋 User ${socket.userId} left conversation ${conversationId}`);
    socket.leave(conversationId);

    if (socket.userId && userConversations.has(socket.userId)) {
      userConversations.get(socket.userId).delete(conversationId);
    }
  });

  // ✅ FIXED: Message sending with proper delivery tracking
  socket.on("message:send", (data) => {
    console.log(`📨 Message sent in conversation ${data.conversationId}`);

    // 1. Broadcast to the conversation room
    io.to(data.conversationId).emit("message:new", data);

    // 2. Initialize delivery tracking
    let deliveredToAnyoneOnline = false;
    const roomSockets =
      io.sockets.adapter.rooms.get(data.conversationId) || new Set();

    // Check if any OTHER users are in the room
    for (const socketId of roomSockets) {
      if (socketId !== socket.id) {
        deliveredToAnyoneOnline = true;
        break;
      }
    }

    // 3. Track which participants received the message
    const deliveredToUsers = new Set();
    if (data.participants && Array.isArray(data.participants)) {
      data.participants.forEach((participantId) => {
        if (participantId === socket.userId) return;

        const participantSocketId = userSockets.get(participantId);

        if (participantSocketId) {
          deliveredToAnyoneOnline = true;
          deliveredToUsers.add(participantId);

          // Send to user if not in room
          if (!roomSockets.has(participantSocketId)) {
            io.to(participantSocketId).emit("message:new", data);
          }
        } else {
          // ✅ FIX: Track pending delivery for offline users
          if (!pendingDeliveries.has(data.conversationId)) {
            pendingDeliveries.set(data.conversationId, new Map());
          }
          const convPending = pendingDeliveries.get(data.conversationId);
          if (!convPending.has(data._id)) {
            convPending.set(data._id, new Set());
          }
          convPending.get(data._id).add(participantId);
        }
      });
    }

    // 4. Emit delivery status if anyone received it
    if (deliveredToAnyoneOnline) {
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

    // ✅ NEW: Notify about unread count update
    io.to(conversationId).emit("conversation:unread-updated", {
      conversationId,
      userId: socket.userId,
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
        isLastMessage,
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

      const lastSeen = Date.now();
      io.emit("user:last-seen", { userId: socket.userId, lastSeen });
      io.emit("user:status", { userId: socket.userId, status: "offline" });

      userSockets.delete(socket.userId);
      onlineUsers.delete(socket.userId);
      userConversations.delete(socket.userId);
    }
  });
});

// ✅ NEW: Process pending deliveries when user comes online
function processPendingDeliveries(userId) {
  for (const [conversationId, messages] of pendingDeliveries.entries()) {
    const deliveredMessages = [];

    for (const [messageId, pendingUsers] of messages.entries()) {
      if (pendingUsers.has(userId)) {
        pendingUsers.delete(userId);
        deliveredMessages.push(messageId);

        // If all users have received it, remove from pending
        if (pendingUsers.size === 0) {
          messages.delete(messageId);
        }
      }
    }

    // Emit delivery status for all pending messages
    if (deliveredMessages.length > 0) {
      deliveredMessages.forEach((messageId) => {
        io.to(conversationId).emit("message:status", {
          messageId,
          status: "delivered",
        });
      });
    }

    // Clean up empty conversation entries
    if (messages.size === 0) {
      pendingDeliveries.delete(conversationId);
    }
  }
}

// ✅ NEW: Check pending deliveries for a specific conversation
function checkPendingDeliveriesForConversation(conversationId, userId) {
  if (!pendingDeliveries.has(conversationId)) return;

  const messages = pendingDeliveries.get(conversationId);
  const deliveredMessages = [];

  for (const [messageId, pendingUsers] of messages.entries()) {
    if (pendingUsers.has(userId)) {
      pendingUsers.delete(userId);
      deliveredMessages.push(messageId);

      if (pendingUsers.size === 0) {
        messages.delete(messageId);
      }
    }
  }

  if (deliveredMessages.length > 0) {
    deliveredMessages.forEach((messageId) => {
      io.to(conversationId).emit("message:status", {
        messageId,
        status: "delivered",
      });
    });
  }

  if (messages.size === 0) {
    pendingDeliveries.delete(conversationId);
  }
}

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, closing server gracefully");

  io.close(() => {
    console.log("✅ WebSocket server closed");
    server.close(() => {
      console.log("✅ HTTP server closed");
      process.exit(0);
    });
  });

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
