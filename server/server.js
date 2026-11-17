/**
 * Group Audio & Video Call Signaling Server (Socket.IO)
 * Multi-party rooms for up to 50 participants.
 * Compatible with both the React Web App and the React Native Mobile App!
 *
 * Run with:
 *   node server/server.js
 */

import http from 'http';
import { Server } from 'socket.io';

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'GroupCall Signaling Server is active', port: PORT }));
});

const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 10000,
});

const rooms = new Map(); // roomId -> Map<userId, { socketId, user, callType }>
const socketLookup = new Map(); // socketId -> { roomId, userId }

io.on('connection', (socket) => {
  console.log(`[Socket Connected] ${socket.id}`);

  // 1. Join Room
  socket.on('room:join', ({ roomId, user, callType }) => {
    if (!roomId || !user?.id) return;
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }

    const room = rooms.get(roomId);
    const existingPeers = [];
    for (const [, data] of room.entries()) {
      existingPeers.push({
        ...data.user,
        isMuted: data.isMuted || false,
        isCameraOff: data.isCameraOff || false,
        isSpeaking: false,
        isHandRaised: false,
      });
    }

    room.set(user.id, {
      socketId: socket.id,
      user,
      callType,
      isMuted: false,
      isCameraOff: false,
      isHandRaised: false,
    });

    socketLookup.set(socket.id, { roomId, userId: user.id });

    // Send existing peers to joining user
    socket.emit('room:peers', { peers: existingPeers });

    // Announce joining user to everyone else in the room
    socket.to(roomId).emit('peer:joined', { user });
    console.log(`[User Joined] ${user.name} (${user.id}) in room ${roomId}. Total: ${room.size}`);
  });

  // 2. WebRTC Peer-to-Peer Offer
  socket.on('peer:offer', ({ roomId, targetUserId, sdp }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const target = room.get(targetUserId);
    const sender = socketLookup.get(socket.id);
    if (target && sender) {
      io.to(target.socketId).emit('peer:offer', {
        senderId: sender.userId,
        sdp,
      });
    }
  });

  // 3. WebRTC Peer-to-Peer Answer
  socket.on('peer:answer', ({ roomId, targetUserId, sdp }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const target = room.get(targetUserId);
    const sender = socketLookup.get(socket.id);
    if (target && sender) {
      io.to(target.socketId).emit('peer:answer', {
        senderId: sender.userId,
        sdp,
      });
    }
  });

  // 4. WebRTC ICE Candidate
  socket.on('peer:ice-candidate', ({ roomId, targetUserId, candidate }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const target = room.get(targetUserId);
    const sender = socketLookup.get(socket.id);
    if (target && sender) {
      io.to(target.socketId).emit('peer:ice-candidate', {
        senderId: sender.userId,
        candidate,
      });
    }
  });

  // 5. Media Toggle (Microphone mute, Camera stop)
  socket.on('peer:media-toggle', ({ roomId, userId, isMuted, isCameraOff }) => {
    const room = rooms.get(roomId);
    if (room && room.has(userId)) {
      const p = room.get(userId);
      p.isMuted = isMuted;
      p.isCameraOff = isCameraOff;
    }
    socket.to(roomId).emit('peer:media-toggle', { userId, isMuted, isCameraOff });
  });

  // 6. Hand Raise
  socket.on('peer:hand-raise', ({ roomId, userId, isHandRaised }) => {
    const room = rooms.get(roomId);
    if (room && room.has(userId)) {
      const p = room.get(userId);
      p.isHandRaised = isHandRaised;
    }
    socket.to(roomId).emit('peer:hand-raise', { userId, isHandRaised });
  });

  // 7. Leave Room
  const handleLeave = () => {
    const meta = socketLookup.get(socket.id);
    if (!meta) return;
    const { roomId, userId } = meta;
    const room = rooms.get(roomId);
    if (room) {
      room.delete(userId);
      socket.to(roomId).emit('peer:left', { userId });
      if (room.size === 0) {
        rooms.delete(roomId);
      }
    }
    socketLookup.delete(socket.id);
    console.log(`[User Left] ${userId} from room ${roomId}`);
  };

  socket.on('room:leave', handleLeave);
  socket.on('disconnect', handleLeave);
});

server.listen(PORT, () => {
  console.log(`\n🚀 GroupCall Signaling Server running on http://localhost:${PORT}`);
  console.log(`   Supports up to 50 concurrent Web and Mobile participants.\n`);
});
