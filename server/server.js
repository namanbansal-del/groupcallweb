/**
 * Enterprise Google Meet WebRTC Group Calling Server (Socket.IO)
 * Focused strictly on multi-user room calling with host administrative controls.
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
 *   toggle-audio     -> broadcasts peer:toggle-audio & toggle-audio
 *   toggle-video     -> broadcasts peer:toggle-video & toggle-video
 *   hand-raise       -> broadcasts hand-raise
 *   change-name      -> broadcasts change-name
 *   host:mute-user   -> host mutes a participant
 *   host:mute-all    -> host mutes everyone
 *   host:stop-screenshare -> host stops a screen share
 *   host:remove-user -> host kicks out a participant
 *   host:settings-update -> updates room meeting permissions
 *   leave-room       -> broadcasts user-disconnected, user-left, peer:left, participant-left
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

// Room & Socket State
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
      name: 'GroupCall WebRTC Multi-User Signaling Server',
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
    console.log(`[Socket Connected] ${socket.id} in namespace ${namespace.name}`);

    // ── 1. JOIN ROOM ───────────────────────────────────────────────
    const handleJoin = (payload = {}, ackCallback) => {
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

      // C. Broadcast to existing users in room
      const connData = {
        socketId: socket.id,
        userName,
        userId,
        totalUsers: room.size,
      };
      socket.to(roomCode).emit('user-connected', connData);
      io.of('/').to(roomCode).emit('user-connected', connData);
      io.of('/call').to(roomCode).emit('user-connected', connData);

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
    const handleOffer = (payload = {}) => {
      const targetId = payload.targetId || payload.to || payload.targetUserId || payload.targetSocketId;
      const offer = payload.offer || payload.sdp;
      if (!targetId || !offer) return;

      const offerData = { from: socket.id, offer };
      namespace.to(targetId).emit('offer', offerData);
      io.of('/').to(targetId).emit('offer', offerData);
      io.of('/call').to(targetId).emit('offer', offerData);

      // Backward-compatible
      const legacyOffer = { senderId: socket.id, sdp: offer };
      namespace.to(targetId).emit('peer:offer', legacyOffer);
      io.of('/').to(targetId).emit('peer:offer', legacyOffer);
      io.of('/call').to(targetId).emit('peer:offer', legacyOffer);
    };

    socket.on('offer', handleOffer);
    socket.on('call:offer', handleOffer);
    socket.on('signal:offer', handleOffer);
    socket.on('peer:offer', handleOffer);

    // ── 3. SDP ANSWER ──────────────────────────────────────────────
    const handleAnswer = (payload = {}) => {
      const targetId = payload.targetId || payload.to || payload.targetUserId || payload.targetSocketId;
      const answer = payload.answer || payload.sdp;
      if (!targetId || !answer) return;

      const answerData = { from: socket.id, answer };
      namespace.to(targetId).emit('answer', answerData);
      io.of('/').to(targetId).emit('answer', answerData);
      io.of('/call').to(targetId).emit('answer', answerData);

      // Backward-compatible
      const legacyAnswer = { senderId: socket.id, sdp: answer };
      namespace.to(targetId).emit('peer:answer', legacyAnswer);
      io.of('/').to(targetId).emit('peer:answer', legacyAnswer);
      io.of('/call').to(targetId).emit('peer:answer', legacyAnswer);
    };

    socket.on('answer', handleAnswer);
    socket.on('call:answer', handleAnswer);
    socket.on('signal:answer', handleAnswer);
    socket.on('peer:answer', handleAnswer);

    // ── 4. ICE CANDIDATE ───────────────────────────────────────────
    const handleIceCandidate = (payload = {}) => {
      const targetId = payload.targetId || payload.to || payload.targetUserId || payload.targetSocketId;
      const candidate = payload.candidate;
      if (!targetId || !candidate) return;

      const iceData = { from: socket.id, candidate };
      namespace.to(targetId).emit('ice-candidate', iceData);
      io.of('/').to(targetId).emit('ice-candidate', iceData);
      io.of('/call').to(targetId).emit('ice-candidate', iceData);

      // Backward-compatible
      const legacyIce = { senderId: socket.id, candidate };
      namespace.to(targetId).emit('peer:ice-candidate', legacyIce);
      io.of('/').to(targetId).emit('peer:ice-candidate', legacyIce);
      io.of('/call').to(targetId).emit('peer:ice-candidate', legacyIce);
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
      const audioEvent = { socketId: socket.id, enabled };
      socket.to(meta.roomCode).emit('peer:toggle-audio', audioEvent);
      socket.to(meta.roomCode).emit('toggle-audio', audioEvent);
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
      const videoEvent = { socketId: socket.id, enabled };
      socket.to(meta.roomCode).emit('peer:toggle-video', videoEvent);
      socket.to(meta.roomCode).emit('toggle-video', videoEvent);
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

    // ── 6. HOST CONTROL EVENTS ─────────────────────────────────────
    // Host can mute a specific participant
    socket.on('host:mute-user', (payload) => {
      const { targetId, roomId } = payload || {};
      const roomCode = roomId || (socketMeta.get(socket.id)?.roomCode);
      if (!roomCode || !targetId) return;
      const room = rooms.get(roomCode);
      if (!room) return;
      for (const [sid, p] of room.entries()) {
        if (sid === targetId || p.userId === targetId || p.socketId === targetId) {
          p.isMuted = true;
          break;
        }
      }
      socket.to(roomCode).emit('peer:toggle-audio', { socketId: targetId, enabled: false });
      socket.to(roomCode).emit('toggle-audio', { socketId: targetId, enabled: false });
      socket.to(roomCode).emit('peer:media-toggle', {
        userId: targetId,
        isMuted: true,
        isCameraOff: false,
      });
    });

    // Host can mute everyone
    socket.on('host:mute-all', (payload) => {
      const { roomId } = payload || {};
      const roomCode = roomId || (socketMeta.get(socket.id)?.roomCode);
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room) return;
      for (const [sid, p] of room.entries()) {
        p.isMuted = true;
      }
      socket.to(roomCode).emit('peer:toggle-audio', { socketId: socket.id, enabled: false });
      socket.to(roomCode).emit('toggle-audio', { socketId: socket.id, enabled: false });
      socket.to(roomCode).emit('peer:media-toggle', {
        userId: socket.id,
        isMuted: true,
        isCameraOff: false,
      });
    });

    // Host can stop a participant's screen share
    socket.on('host:stop-screenshare', (payload) => {
      const { targetId, roomId } = payload || {};
      const roomCode = roomId || (socketMeta.get(socket.id)?.roomCode);
      if (!roomCode || !targetId) return;
      socket.to(roomCode).emit('peer:toggle-screen-share', {
        socketId: targetId,
        enabled: false,
        isScreenSharing: false,
      });
    });

    // Host can remove a participant
    socket.on('host:remove-user', (payload) => {
      const { targetId, roomId } = payload || {};
      const roomCode = roomId || (socketMeta.get(socket.id)?.roomCode);
      if (!roomCode || !targetId) return;
      const room = rooms.get(roomCode);
      if (!room) return;
      let targetSid = null;
      for (const [sid, p] of room.entries()) {
        if (sid === targetId || p.userId === targetId || p.socketId === targetId) {
          targetSid = sid;
          break;
        }
      }
      if (targetSid) {
        room.delete(targetSid);
        const targetSocket = io.of('/').sockets.get(targetSid) || io.of('/call').sockets.get(targetSid);
        if (targetSocket) {
          targetSocket.emit('host-remove');
        }
        socket.to(roomCode).emit('peer:left', { userId: targetId, socketId: targetId });
        socket.to(roomCode).emit('user-left', { userId: targetId, socketId: targetId });
        socket.to(roomCode).emit('user-disconnected', {
          socketId: targetId,
          userName: '',
          remainingCount: room.size,
        });
        socket.to(roomCode).emit('participant-left', { socketId: targetId, userId: targetId });
        if (room.size === 0) {
          rooms.delete(roomCode);
        }
      }
    });

    // Host can update meeting permissions
    socket.on('host:settings-update', (payload) => {
      const { settings, roomId } = payload || {};
      const roomCode = roomId || (socketMeta.get(socket.id)?.roomCode);
      if (!roomCode) return;
      socket.to(roomCode).emit('peer:host-settings', { settings });
    });

    // ── 7. LEAVE / DISCONNECT (Ghost Participant Cleanup) ──────────
    const handleLeave = () => {
      const meta = socketMeta.get(socket.id);
      if (!meta) return;
      const { roomCode, userName } = meta;
      const room = rooms.get(roomCode);

      if (room) {
        room.delete(socket.id);
        const remainingCount = room.size;

        const dcEvent = {
          socketId: socket.id,
          userId: socket.id,
          userName,
          remainingCount,
        };

        // Broadcast cleanup events
        socket.to(roomCode).emit('user-disconnected', dcEvent);
        socket.to(roomCode).emit('user-left', dcEvent);
        socket.to(roomCode).emit('peer:left', { userId: socket.id, socketId: socket.id });
        socket.to(roomCode).emit('participant-left', dcEvent);

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

// Support both root '/' and '/call' namespaces
registerSocketHandlers(io.of('/'));
registerSocketHandlers(io.of('/call'));

server.listen(PORT, () => {
  console.log(`\n🚀 GroupCall Multi-User Google Meet Signaling Server running on http://localhost:${PORT}`);
  console.log(`   Namespaces: '/' and '/call'`);
  console.log(`   REST Config: GET  /api/webrtc/config`);
  console.log(`   Rooms:       GET  /api/rooms`);
  console.log(`   Supports up to 50 concurrent Web and Mobile participants.\n`);
});
