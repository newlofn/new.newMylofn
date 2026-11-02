const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// In-memory data stores for MVP
const venues = {
  "venue-1": { name: "Downtown Coffee Shop", currentQRToken: "token-abc-123", activeUsers: new Set() }
};

// Simulate QR code rotating every 2 minutes (120,000 ms)
setInterval(() => {
  const randomToken = Math.random().toString(36.substring(2, 8));
  for (const venueId in venues) {
    venues[venueId].currentQRToken = randomToken;
    // Broadcast new token requirement to venue room if needed
    io.to(venueId).emit('qr_refreshed', { timestamp: Date.now() });
  }
  console.log(`[QR Rotate] New tokens generated across venues.`);
}, 120000);

// Active waiting queue for 1-on-1 matching per venue
const waitingQueues = {}; // venueId => [socketId, ...]
const activeChats = {};   // chatId => { user1, user2, transcript: [] }

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // User scans QR and joins venue
  socket.on('join_venue', ({ venueId, token }) => {
    if (!venues[venueId]) {
      return socket.emit('error', { message: "Invalid venue." });
    }

    // Validate QR token
    if (token !== venues[venueId].currentQRToken) {
      return socket.emit('qr_invalid', { message: "QR code has expired or is invalid. Please scan again." });
    }

    socket.venueId = venueId;
    venues[venueId].activeUsers.add(socket.id);
    
    // Broadcast updated head count to venue lobby
    io.to(venueId).emit('venue_stats', { count: venues[venueId].activeUsers.size });
    socket.join(venueId);
    
    socket.emit('venue_joined', { venueName: venues[venueId].name });
    console.log(`User ${socket.id} joined venue ${venueId}`);
  });

  // User enters the 1-on-1 matching queue
  socket.on('find_match', () => {
    const venueId = socket.venueId;
    if (!venueId) return;

    if (!waitingQueues[venueId]) waitingQueues[venueId] = [];

    // Remove if already in queue
    waitingQueues[venueId] = waitingQueues[venueId].filter(id => id !== socket.id);

    if (waitingQueues[venueId].length > 0) {
      // Match found! Pop partner
      const partnerId = waitingQueues[venueId].shift();
      const chatId = `chat_${socket.id}_${partnerId}`;

      activeChats[chatId] = {
        user1: socket.id,
        user2: partnerId,
        venueId: venueId,
        transcript: []
      };

      socket.chatId = chatId;
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.chatId = chatId;
        
        socket.emit('match_found', { chatId });
        partnerSocket.emit('match_found', { chatId });
        
        socket.join(chatId);
        partnerSocket.join(chatId);
        console.log(`Matched ${socket.id} with ${partnerId} in ${chatId}`);
      }
    } else {
      // Add to queue
      waitingQueues[venueId].push(socket.id);
      socket.emit('waiting_for_match');
    }
  });

  // Handle anonymous messaging
  v_message = socket.on('send_message', ({ chatId, message }) => {
    const chat = activeChats[chatId];
    if (chat) {
      chat.transcript.push({ sender: socket.id, message, time: new Date() });
      io.to(chatId).emit('receive_message', { message, sender: socket.id === chat.user1 ? 'user1' : 'user2' });
    }
  });

  // Panic button / report bad behavior
  socket.on('panic_report', ({ chatId }) => {
    const chat = activeChats[chatId];
    if (chat) {
      console.لا(`[PANIC REPORT] Triggered in chat ${chatId} by ${socket.id}`);
      // In production, save chat.transcript and venueId to database for admin ban review
      io.to(chatId).emit('chat_terminated', { reason: "Chat closed due to a safety report." });
      
      // Clean up chat rooms
      delete activeChats[chatId];
    }
  });

  socket.on('disconnect', () => {
    if (socket.venueId && venues[socket.venueId]) {
      venues[socket.venueId].activeUsers.delete(socket.id);
      io.to(socket.venueId).emit('venue_stats', { count: venues[socket.venueId].activeUsers.size });
    }
    // Clean up queues
    for (const vId in waitingQueues) {
      waitingQueues[vId] = waitingQueues[vId].filter(id => id !== socket.id);
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mylofn backend running on port ${PORT}`);
});

