// FIXED WebSocket Server (websocket-server.js)
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
});

const userSockets = new Map(); // userId -> socketId
const onlineUsers = new Set();
const userConversations = new Map(); // userId -> Set of conversationIds

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

    // Send initial online users list to the connecting user
    socket.emit("users:online-list", {
      onlineUsers: Array.from(onlineUsers),
    });

    // Broadcast to others that this user is online
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

  // NEW MESSAGE HANDLER - CRITICAL FIX
  // SIMPLIFIED MESSAGE HANDLER
  socket.on("message:send", (data) => {
    console.log(`📨 Message sent in conversation ${data.conversationId}`);

    // Broadcast to everyone in the conversation room (people actively viewing it)
    io.to(data.conversationId).emit("message:new", data);

    // **ALSO send to all participants' personal rooms**
    // This ensures they get the notification even if not viewing the chat
    if (data.participants && Array.isArray(data.participants)) {
      data.participants.forEach((participantId) => {
        // Emit to each participant's personal room
        // The client will handle deduplication and proper status updates
        io.to(participantId).emit("message:new", data);
      });
    }

    // Check if anyone is viewing the conversation for delivery status
    const conversationSockets = io.sockets.adapter.rooms.get(
      data.conversationId
    );

    if (conversationSockets) {
      console.log(
        `👥 Conversation has ${conversationSockets.size} active viewers`
      );

      // If more than just the sender is viewing (size > 1), mark as delivered
      if (conversationSockets.size > 1) {
        setTimeout(() => {
          console.log(`✅ Message ${data._id} marked as delivered`);
          io.to(data.conversationId).emit("message:status", {
            messageId: data._id,
            status: "delivered",
          });
        }, 100);
      } else {
        console.log(
          `⏳ Only sender viewing, message ${data._id} stays as 'sent'`
        );
      }
    }
  });

  // DELIVERED STATUS - User received message but hasn't opened chat
  socket.on("message:delivered", ({ messageId, conversationId }) => {
    console.log(`✅ Message ${messageId} delivered`);
    io.to(conversationId).emit("message:status", {
      messageId,
      status: "delivered",
    });
  });

  // READ STATUS - User opened chat and saw message
  socket.on("message:read", ({ messageId, conversationId }) => {
    console.log(`👀 Message ${messageId} read`);
    io.to(conversationId).emit("message:status", {
      messageId,
      status: "read",
    });
  });

  // BULK READ - When user opens a conversation, mark all unread as read
  socket.on("messages:mark-read", ({ messageIds, conversationId }) => {
    console.log(
      `👀 Marking ${messageIds.length} messages as read in ${conversationId}`
    );
    messageIds.forEach((messageId) => {
      io.to(conversationId).emit("message:status", {
        messageId,
        status: "read",
      });
    });
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

server.listen(port, "0.0.0.0", () => {
  console.log(`> WebSocket server ready on port ${port}`);
});
