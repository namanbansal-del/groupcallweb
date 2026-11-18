/**
 * Group Audio & Video Call Signaling Server (Socket.IO)
 * Complies with the Frontend Integration Guide: Multi-User WebRTC Calling.
 *
 * REST Endpoints:
 *   GET /api/webrtc/config -> Returns ICE servers (STUN/TURN) & staticRoomCode
 *   GET /api/rooms          -> Returns { activeRoomsCount, totalConnectedUsers, rooms: [...] }
 *   GET /api/rooms/:code    -> Returns { roomCode, totalUsers, participants: [...] }
 *
 * Socket Events (Root '/' and '/call'):
 *   join-room        -> receives all-users; broadcasts user-connected
 *   offer            -> relays { from, offer } to target
 *   answer           -> relays { from, answer } to target
 *   ice-candidate    -> relays { from, candidate } to target
 *   toggle-audio     -> broadcasts peer:toggle-audio
 *   toggle-video     -> broadcasts peer:toggle-video
 *   leave-room       -> broadcasts user-disconnected
 */

import http from 'http';
import { Server } from 'socket.io';

const PORT = process.env.PORT || 4000;
const STATIC_ROOM_CODE = process.env.STATIC_ROOM_CODE || 'TEST-ROOM';

const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302'] },
  { urls: ['stun:stun1.l.google.com:19302'] },
  { urls: ['stun:stun2.l.google.com:19302'] },
];

const rooms = new Map(); // roomCode -> Map<socketId, { socketId, userId, userName, isMuted, isCameraOff }>
const socketMeta = new Map(); // socketId -> { roomCode, userId, userName }

const server = http.createServer((req, res) => {
  // Enable CORS for REST endpoints
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 1. GET /api/webrtc/config
  if (url.pathname === '/api/webrtc/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        iceServers: DEFAULT_ICE_SERVERS,
        staticRoomCode: STATIC_ROOM_CODE,
      })
    );
    return;
  }

  // 2. GET /api/rooms
  if (url.pathname === '/api/rooms') {
    let totalConnectedUsers = 0;
    const roomList = [];

    for (const [code, userMap] of rooms.entries()) {
      totalConnectedUsers += userMap.size;
      roomList.push({
        roomCode: code,
        userCount: userMap.size,
        participants: Array.from(userMap.values()),
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        activeRoomsCount: rooms.size,
        totalConnectedUsers,
        rooms: roomList,
      })
    );
    return;
  }

  // 3. GET /api/rooms/:code
  if (url.pathname.startsWith('/api/rooms/')) {
    const code = decodeURIComponent(url.pathname.replace('/api/rooms/', '')).toUpperCase();
    const userMap = rooms.get(code);

    if (!userMap) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ roomCode: code, totalUsers: 0, participants: [] }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        roomCode: code,
        totalUsers: userMap.size,
        participants: Array.from(userMap.values()),
      })
    );
    return;
  }

  // Root status
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      name: 'GroupCall Multi-User Signaling Server',
      status: 'active',
      port: PORT,
      activeRooms: rooms.size,
      staticRoomCode: STATIC_ROOM_CODE,
    })
  );
});

const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 10000,
});

function registerSocketHandlers(namespace) {
  namespace.on('connection', (socket) => {
    console.log(`[Socket Connected] ${socket.id}`);

    // ── 1. JOIN ROOM ───────────────────────────────────────────────
    const handleJoin = (payload, ackCallback) => {
      const roomCode = (payload.roomCode || payload.roomId || STATIC_ROOM_CODE).trim().toUpperCase();
      const userName = payload.userName || payload.user?.name || `User_${socket.id.slice(0, 4)}`;
      const userId = payload.userId || payload.user?.id || `user_${socket.id.slice(0, 6)}`;

      socket.join(roomCode);

      if (!rooms.has(roomCode)) {
        rooms.set(roomCode, new Map());
      }
      const room = rooms.get(roomCode);

      // Collect existing users to send to the joiner
      const existingUsers = [];
      const legacyPeers = [];
      for (const [, existing] of room.entries()) {
        existingUsers.push({
          socketId: existing.socketId,
          userName: existing.userName,
          userId: existing.userId,
          isMuted: existing.isMuted,
          isCameraOff: existing.isCameraOff,
        });
        legacyPeers.push({
          id: existing.socketId,
          name: existing.userName,
          isMuted: existing.isMuted,
          isCameraOff: existing.isCameraOff,
        });
      }

      // Store joiner info
      const participant = {
        socketId: socket.id,
        userId,
        userName,
        isMuted: false,
        isCameraOff: false,
      };
      room.set(socket.id, participant);
      socketMeta.set(socket.id, { roomCode, userId, userName });

      // A. Standard event to joiner
      socket.emit('all-users', { users: existingUsers });
      // B. Backward-compatible event to joiner
      socket.emit('room:peers', { peers: legacyPeers });

      // C. Broadcast to existing users in the room
      socket.to(roomCode).emit('user-connected', {
        socketId: socket.id,
        userName,
        userId,
        totalUsers: room.size,
      });
      // Backward-compatible
      socket.to(roomCode).emit('peer:joined', {
        user: { id: socket.id, name: userName },
      });

      console.log(`[Join Room] ${userName} (${socket.id}) in '${roomCode}'. Total: ${room.size}`);

      if (typeof ackCallback === 'function') {
        ackCallback({ roomCode, totalUsers: room.size });
      }
    };

    socket.on('join-room', handleJoin);
    socket.on('room:join', handleJoin);
    socket.on('call:join', handleJoin);

    // ── 2. SDP OFFER ───────────────────────────────────────────────
    const handleOffer = (payload) => {
      const targetId = payload.to || payload.targetUserId || payload.targetSocketId;
      const offer = payload.offer || payload.sdp;
      if (!targetId || !offer) return;

      io.to(targetId).emit('offer', {
        from: socket.id,
        offer,
      });
      // Backward-compatible
      io.to(targetId).emit('peer:offer', {
        senderId: socket.id,
        sdp: offer,
      });
    };

    socket.on('offer', handleOffer);
    socket.on('call:offer', handleOffer);
    socket.on('signal:offer', handleOffer);
    socket.on('peer:offer', handleOffer);

    // ── 3. SDP ANSWER ──────────────────────────────────────────────
    const handleAnswer = (payload) => {
      const targetId = payload.to || payload.targetUserId || payload.targetSocketId;
      const answer = payload.answer || payload.sdp;
      if (!targetId || !answer) return;

      io.to(targetId).emit('answer', {
        from: socket.id,
        answer,
      });
      // Backward-compatible
      io.to(targetId).emit('peer:answer', {
        senderId: socket.id,
        sdp: answer,
      });
    };

    socket.on('answer', handleAnswer);
    socket.on('call:answer', handleAnswer);
    socket.on('signal:answer', handleAnswer);
    socket.on('peer:answer', handleAnswer);

    // ── 4. ICE CANDIDATE ───────────────────────────────────────────
    const handleIceCandidate = (payload) => {
      const targetId = payload.to || payload.targetUserId || payload.targetSocketId;
      const candidate = payload.candidate;
      if (!targetId || !candidate) return;

      io.to(targetId).emit('ice-candidate', {
        from: socket.id,
        candidate,
      });
      // Backward-compatible
      io.to(targetId).emit('peer:ice-candidate', {
        senderId: socket.id,
        candidate,
      });
    };

    socket.on('ice-candidate', handleIceCandidate);
    socket.on('call:ice-candidate', handleIceCandidate);
    socket.on('signal:ice-candidate', handleIceCandidate);
    socket.on('peer:ice-candidate', handleIceCandidate);

    // ── 5. MEDIA TOGGLES ───────────────────────────────────────────
    socket.on('toggle-audio', ({ enabled }) => {
      const meta = socketMeta.get(socket.id);
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (room && room.has(socket.id)) {
        room.get(socket.id).isMuted = !enabled;
      }
      socket.to(meta.roomCode).emit('peer:toggle-audio', {
        socketId: socket.id,
        enabled,
      });
      socket.to(meta.roomCode).emit('peer:media-toggle', {
        userId: socket.id,
        isMuted: !enabled,
        isCameraOff: room ? room.get(socket.id)?.isCameraOff : false,
      });
    });

    socket.on('toggle-video', ({ enabled }) => {
      const meta = socketMeta.get(socket.id);
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (room && room.has(socket.id)) {
        room.get(socket.id).isCameraOff = !enabled;
      }
      socket.to(meta.roomCode).emit('peer:toggle-video', {
        socketId: socket.id,
        enabled,
      });
      socket.to(meta.roomCode).emit('peer:media-toggle', {
        userId: socket.id,
        isMuted: room ? room.get(socket.id)?.isMuted : false,
        isCameraOff: !enabled,
      });
    });

    // Hand raise
    const handleHandRaise = (payload = {}) => {
      const meta = socketMeta.get(socket.id);
      const roomCode = meta?.roomCode || payload.roomId || payload.roomCode;
      if (!roomCode) return;

      const isHandRaised =
        typeof payload.isHandRaised === 'boolean'
          ? payload.isHandRaised
          : typeof payload.enabled === 'boolean'
          ? payload.enabled
          : typeof payload.raised === 'boolean'
          ? payload.raised
          : true;

      const eventData = {
        userId: meta?.userId || payload.userId || socket.id,
        socketId: socket.id,
        id: socket.id,
        isHandRaised,
        enabled: isHandRaised,
      };

      socket.to(roomCode).emit('peer:hand-raise', eventData);
      socket.to(roomCode).emit('hand-raise', eventData);
    };

    socket.on('peer:hand-raise', handleHandRaise);
    socket.on('hand-raise', handleHandRaise);
    socket.on('raise-hand', handleHandRaise);

    // Name change
    const handleNameChange = (payload = {}) => {
      const newName = (payload.userName || payload.name || '').trim();
      if (!newName) return;
      const meta = socketMeta.get(socket.id);
      if (!meta) return;

      meta.userName = newName;
      const room = rooms.get(meta.roomCode);
      if (room && room.has(socket.id)) {
        room.get(socket.id).userName = newName;
      }

      const eventData = {
        userId: meta.userId || socket.id,
        socketId: socket.id,
        id: socket.id,
        userName: newName,
        name: newName,
      };

      socket.to(meta.roomCode).emit('peer:name-change', eventData);
      socket.to(meta.roomCode).emit('change-name', eventData);
      console.log(`[Name Change] ${socket.id} changed name to '${newName}' in '${meta.roomCode}'`);
    };

    socket.on('change-name', handleNameChange);
    socket.on('peer:name-change', handleNameChange);
    socket.on('user:update-name', handleNameChange);

    // ── 6. LEAVE / DISCONNECT ──────────────────────────────────────
    const handleLeave = () => {
      const meta = socketMeta.get(socket.id);
      if (!meta) return;
      const { roomCode, userName } = meta;
      const room = rooms.get(roomCode);

      if (room) {
        room.delete(socket.id);
        const remainingCount = room.size;

        socket.to(roomCode).emit('user-disconnected', {
          socketId: socket.id,
          userName,
          remainingCount,
        });
        socket.to(roomCode).emit('peer:left', {
          userId: socket.id,
          socketId: socket.id,
        });

        if (room.size === 0) {
          rooms.delete(roomCode);
        }
        console.log(`[User Left] ${userName} (${socket.id}) from '${roomCode}'. Remaining: ${remainingCount}`);
      }

      socketMeta.delete(socket.id);
    };

    socket.on('leave-room', handleLeave);
    socket.on('call:leave', handleLeave);
    socket.on('room:leave', handleLeave);
    socket.on('disconnect', handleLeave);
  });
}

// Support both root '/' and '/call' namespaces as requested
registerSocketHandlers(io.of('/'));
registerSocketHandlers(io.of('/call'));

server.listen(PORT, () => {
  console.log(`\n🚀 GroupCall Multi-User Signaling Server running on http://localhost:${PORT}`);
  console.log(`   Namespaces: '/' and '/call'`);
  console.log(`   REST Config: http://localhost:${PORT}/api/webrtc/config`);
  console.log(`   Active Rooms: http://localhost:${PORT}/api/rooms`);
  console.log(`   Supports up to 50 concurrent Web and Mobile participants.\n`);
});
