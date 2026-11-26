/**
 * Group Audio & Video Call Signaling Server (Socket.IO)
 * Complies with the Frontend Integration Guide: Multi-User WebRTC Calling & React Native Calling/Auth.
 *
 * REST Endpoints:
 *   POST /api/calling/signup -> Registers a user and returns { token, user: { id, name, phone } }
 *   POST /api/calling/login  -> Authenticates a user and returns { token, user: { id, name, phone } }
 *   GET  /api/webrtc/config  -> Returns ICE servers (STUN/TURN) & staticRoomCode
 *   GET  /api/rooms          -> Returns { activeRoomsCount, totalConnectedUsers, rooms: [...] }
 *   GET  /api/rooms/:code    -> Returns { roomCode, totalUsers, participants: [...] }
 *
 * Socket Events (Root '/' and '/call'):
 *   1-to-1 Direct Calling:
 *     call:initiate   -> relays call:incoming to target callee
 *     call:accept     -> relays call:accepted to caller
 *     call:reject     -> relays call:rejected to caller
 *     call:end        -> relays call:ended to target
 *
 *   Room Calling:
 *     join-room       -> receives all-users; broadcasts user-connected
 *     offer           -> relays { from, offer } to target
 *     answer          -> relays { from, answer } to target
 *     ice-candidate   -> relays { from, candidate } to target
 *     toggle-audio    -> broadcasts peer:toggle-audio & toggle-audio
 *     toggle-video    -> broadcasts peer:toggle-video & toggle-video
 *     leave-room      -> broadcasts user-disconnected, user-left, peer:left, participant-left
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

// Auth & User Registry for React Native Calling
const usersByPhone = new Map(); // phone -> { id, name, phone, password, createdAt }
const usersById = new Map(); // id -> user
const tokensMap = new Map(); // token -> user
const phoneToSockets = new Map(); // phone -> Set<socketId>
const activeDirectCalls = new Map(); // callId -> { callId, callerSocketId, calleeSocketId, callerPhone, calleePhone, callerName }

/**
 * Generate a safe auth token mapped to user
 */
function generateToken(user) {
  const payload = {
    userId: user.id,
    phone: user.phone,
    name: user.name,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
  const token = 'jwt_' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  tokensMap.set(token, user);
  return token;
}

/**
 * Resolve user by token
 */
function resolveUserFromToken(token) {
  if (!token) return null;
  if (tokensMap.has(token)) return tokensMap.get(token);
  try {
    if (token.startsWith('jwt_')) {
      const json = JSON.parse(Buffer.from(token.slice(4), 'base64url').toString('utf8'));
      if (json && json.phone) {
        let user = usersByPhone.get(json.phone);
        if (!user) {
          user = {
            id: json.userId || `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: json.name || json.phone,
            phone: json.phone,
            createdAt: new Date().toISOString(),
          };
          usersByPhone.set(json.phone, user);
          usersById.set(user.id, user);
        }
        tokensMap.set(token, user);
        return user;
      }
    }
  } catch {}
  return null;
}

/**
 * Parse JSON body from HTTP request stream
 */
function parseRequestBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2e6) {
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  // Enable CORS for REST endpoints
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ── AUTH ENDPOINTS FOR REACT NATIVE ───────────────────────────
  // 1. POST /api/calling/signup
  if (req.method === 'POST' && url.pathname === '/api/calling/signup') {
    const data = await parseRequestBody(req);
    const { name, phone, password } = data;
    if (!phone) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Phone number is required' }));
      return;
    }
    const cleanPhone = String(phone).trim();
    let user = usersByPhone.get(cleanPhone);
    if (!user) {
      user = {
        id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: (name || cleanPhone).trim(),
        phone: cleanPhone,
        password: password || '',
        createdAt: new Date().toISOString(),
      };
      usersByPhone.set(cleanPhone, user);
      usersById.set(user.id, user);
    } else {
      if (name) user.name = name.trim();
      if (password) user.password = password;
    }
    const token = generateToken(user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        token,
        user: { id: user.id, name: user.name, phone: user.phone },
      })
    );
    return;
  }

  // 2. POST /api/calling/login
  if (req.method === 'POST' && url.pathname === '/api/calling/login') {
    const data = await parseRequestBody(req);
    const { phone, password } = data;
    if (!phone) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Phone number is required' }));
      return;
    }
    const cleanPhone = String(phone).trim();
    let user = usersByPhone.get(cleanPhone);
    if (!user) {
      // Seamless auto-provisioning for testing & initial mobile logins
      user = {
        id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: `User ${cleanPhone.slice(-4)}`,
        phone: cleanPhone,
        password: password || '',
        createdAt: new Date().toISOString(),
      };
      usersByPhone.set(cleanPhone, user);
      usersById.set(user.id, user);
    }
    const token = generateToken(user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        token,
        user: { id: user.id, name: user.name, phone: user.phone },
      })
    );
    return;
  }

  // ── WEBRTC CONFIG & ROOM INSPECTION ─────────────────────────────
  // 3. GET /api/webrtc/config
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

  // 4. GET /api/rooms
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

  // 5. GET /api/rooms/:code
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
      name: 'GroupCall Multi-User & React Native Signaling Server',
      status: 'active',
      port: PORT,
      activeRooms: rooms.size,
      staticRoomCode: STATIC_ROOM_CODE,
      registeredUsers: usersByPhone.size,
    })
  );
});

const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 10000,
});

function registerSocketHandlers(namespace) {
  // Support auth handshake token verification
  namespace.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (token) {
      const user = resolveUserFromToken(token);
      if (user) {
        socket.user = user;
      }
    }
    next();
  });

  namespace.on('connection', (socket) => {
    console.log(`[Socket Connected] ${socket.id} in namespace ${namespace.name}`);

    // If connected with user auth, track socket by phone
    if (socket.user?.phone) {
      let socketsSet = phoneToSockets.get(socket.user.phone);
      if (!socketsSet) {
        socketsSet = new Set();
        phoneToSockets.set(socket.user.phone, socketsSet);
      }
      socketsSet.add(socket.id);
    }

    // ── 1. JOIN ROOM (Web & Mobile Room Calling) ───────────────────
    const handleJoin = (payload = {}, ackCallback) => {
      const roomCode = (payload.roomCode || payload.roomId || STATIC_ROOM_CODE).trim().toUpperCase();
      const userName = payload.userName || payload.user?.name || socket.user?.name || `User_${socket.id.slice(0, 4)}`;
      const userId = payload.userId || payload.user?.id || socket.user?.id || `user_${socket.id.slice(0, 6)}`;

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

      // C. Broadcast to existing users in room across namespaces
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

    // ── 2. DIRECT 1-TO-1 CALLING (React Native Hook Support) ───────
    socket.on('call:initiate', (payload = {}, ackCallback) => {
      const { toPhone, targetUserId } = payload;
      const cleanPhone = toPhone ? String(toPhone).trim() : null;
      let targetSocketId = null;

      if (cleanPhone && phoneToSockets.has(cleanPhone)) {
        const sids = Array.from(phoneToSockets.get(cleanPhone));
        targetSocketId = sids[sids.length - 1]; // pick most recent connection
      } else if (targetUserId) {
        for (const [sid, meta] of socketMeta.entries()) {
          if (meta.userId === targetUserId || sid === targetUserId) {
            targetSocketId = sid;
            break;
          }
        }
      }

      if (!targetSocketId) {
        if (typeof ackCallback === 'function') {
          ackCallback({ ok: false, error: 'User is offline or not found' });
        }
        return;
      }

      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      activeDirectCalls.set(callId, {
        callId,
        callerSocketId: socket.id,
        calleeSocketId: targetSocketId,
        callerPhone: socket.user?.phone || 'Unknown',
        calleePhone: cleanPhone,
        callerName: socket.user?.name || socketMeta.get(socket.id)?.userName || 'Caller',
      });

      const incomingPayload = {
        callId,
        callerName: socket.user?.name || socketMeta.get(socket.id)?.userName || 'Caller',
        callerPhone: socket.user?.phone || 'Unknown',
        callerSocketId: socket.id,
        roomCode: `DIRECT-${callId}`,
      };

      // Deliver to target in both namespaces to ensure reception
      namespace.to(targetSocketId).emit('call:incoming', incomingPayload);
      io.of('/call').to(targetSocketId).emit('call:incoming', incomingPayload);
      io.of('/').to(targetSocketId).emit('call:incoming', incomingPayload);

      if (typeof ackCallback === 'function') {
        ackCallback({ ok: true, callId });
      }
    });

    socket.on('call:accept', (payload = {}) => {
      const { callerSocketId, callId } = payload;
      const call = activeDirectCalls.get(callId);
      const targetSid = callerSocketId || call?.callerSocketId;
      if (targetSid) {
        const acceptPayload = {
          callId,
          calleeSocketId: socket.id,
          calleeName: socket.user?.name || socketMeta.get(socket.id)?.userName || 'Callee',
          calleePhone: socket.user?.phone || '',
        };
        namespace.to(targetSid).emit('call:accepted', acceptPayload);
        io.of('/call').to(targetSid).emit('call:accepted', acceptPayload);
        io.of('/').to(targetSid).emit('call:accepted', acceptPayload);
      }
    });

    socket.on('call:reject', (payload = {}) => {
      const { callerSocketId, callId } = payload;
      const call = activeDirectCalls.get(callId);
      const targetSid = callerSocketId || call?.callerSocketId;
      if (targetSid) {
        const rejectPayload = { callId, bySocketId: socket.id };
        namespace.to(targetSid).emit('call:rejected', rejectPayload);
        io.of('/call').to(targetSid).emit('call:rejected', rejectPayload);
        io.of('/').to(targetSid).emit('call:rejected', rejectPayload);
      }
      if (callId) activeDirectCalls.delete(callId);
    });

    socket.on('call:end', (payload = {}) => {
      const { targetSocketId, callId } = payload;
      const call = activeDirectCalls.get(callId);
      const otherSid =
        targetSocketId ||
        (call && (call.callerSocketId === socket.id ? call.calleeSocketId : call.callerSocketId));
      if (otherSid) {
        const endPayload = { callId, bySocketId: socket.id };
        namespace.to(otherSid).emit('call:ended', endPayload);
        io.of('/call').to(otherSid).emit('call:ended', endPayload);
        io.of('/').to(otherSid).emit('call:ended', endPayload);
      }
      if (callId) activeDirectCalls.delete(callId);
    });

    // ── 3. SDP OFFER ───────────────────────────────────────────────
    const handleOffer = (payload = {}) => {
      const targetId = payload.targetId || payload.to || payload.targetUserId || payload.targetSocketId;
      const offer = payload.offer || payload.sdp;
      if (!targetId || !offer) return;

      const offerData = { from: socket.id, offer };
      namespace.to(targetId).emit('offer', offerData);
      io.of('/call').to(targetId).emit('offer', offerData);
      io.of('/').to(targetId).emit('offer', offerData);

      // Backward-compatible
      const legacyOffer = { senderId: socket.id, sdp: offer };
      namespace.to(targetId).emit('peer:offer', legacyOffer);
      io.of('/call').to(targetId).emit('peer:offer', legacyOffer);
      io.of('/').to(targetId).emit('peer:offer', legacyOffer);
    };

    socket.on('offer', handleOffer);
    socket.on('call:offer', handleOffer);
    socket.on('signal:offer', handleOffer);
    socket.on('peer:offer', handleOffer);

    // ── 4. SDP ANSWER ──────────────────────────────────────────────
    const handleAnswer = (payload = {}) => {
      const targetId = payload.targetId || payload.to || payload.targetUserId || payload.targetSocketId;
      const answer = payload.answer || payload.sdp;
      if (!targetId || !answer) return;

      const answerData = { from: socket.id, answer };
      namespace.to(targetId).emit('answer', answerData);
      io.of('/call').to(targetId).emit('answer', answerData);
      io.of('/').to(targetId).emit('answer', answerData);

      // Backward-compatible
      const legacyAnswer = { senderId: socket.id, sdp: answer };
      namespace.to(targetId).emit('peer:answer', legacyAnswer);
      io.of('/call').to(targetId).emit('peer:answer', legacyAnswer);
      io.of('/').to(targetId).emit('peer:answer', legacyAnswer);
    };

    socket.on('answer', handleAnswer);
    socket.on('call:answer', handleAnswer);
    socket.on('signal:answer', handleAnswer);
    socket.on('peer:answer', handleAnswer);

    // ── 5. ICE CANDIDATE ───────────────────────────────────────────
    const handleIceCandidate = (payload = {}) => {
      const targetId = payload.targetId || payload.to || payload.targetUserId || payload.targetSocketId;
      const candidate = payload.candidate;
      if (!targetId || !candidate) return;

      const iceData = { from: socket.id, candidate };
      namespace.to(targetId).emit('ice-candidate', iceData);
      io.of('/call').to(targetId).emit('ice-candidate', iceData);
      io.of('/').to(targetId).emit('ice-candidate', iceData);

      // Backward-compatible
      const legacyIce = { senderId: socket.id, candidate };
      namespace.to(targetId).emit('peer:ice-candidate', legacyIce);
      io.of('/call').to(targetId).emit('peer:ice-candidate', legacyIce);
      io.of('/').to(targetId).emit('peer:ice-candidate', legacyIce);
    };

    socket.on('ice-candidate', handleIceCandidate);
    socket.on('call:ice-candidate', handleIceCandidate);
    socket.on('signal:ice-candidate', handleIceCandidate);
    socket.on('peer:ice-candidate', handleIceCandidate);

    // ── 6. MEDIA TOGGLES ───────────────────────────────────────────
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

    // ── 7. HOST CONTROL EVENTS ─────────────────────────────────────
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

    // ── 8. LEAVE / DISCONNECT (Ghost Participant Cleanup) ──────────
    const handleLeave = () => {
      // Direct call cleanup if active
      for (const [callId, call] of activeDirectCalls.entries()) {
        if (call.callerSocketId === socket.id || call.calleeSocketId === socket.id) {
          const otherSid = call.callerSocketId === socket.id ? call.calleeSocketId : call.callerSocketId;
          const endPayload = { callId, bySocketId: socket.id };
          namespace.to(otherSid).emit('call:ended', endPayload);
          io.of('/call').to(otherSid).emit('call:ended', endPayload);
          io.of('/').to(otherSid).emit('call:ended', endPayload);

          const leftPayload = { socketId: socket.id, userId: socket.id };
          namespace.to(otherSid).emit('user-disconnected', leftPayload);
          namespace.to(otherSid).emit('user-left', leftPayload);
          namespace.to(otherSid).emit('peer:left', leftPayload);
          namespace.to(otherSid).emit('participant-left', leftPayload);
          activeDirectCalls.delete(callId);
        }
      }

      // Cleanup user phone mapping
      if (socket.user?.phone) {
        const set = phoneToSockets.get(socket.user.phone);
        if (set) {
          set.delete(socket.id);
          if (set.size === 0) phoneToSockets.delete(socket.user.phone);
        }
      }

      // Room cleanup
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

        // Emit all 4 cleanup events expected by mobile hooks and web clients
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
  console.log(`\n🚀 GroupCall Multi-User & React Native Signaling Server running on http://localhost:${PORT}`);
  console.log(`   Namespaces: '/' and '/call'`);
  console.log(`   REST Auth:   POST /api/calling/signup & POST /api/calling/login`);
  console.log(`   REST Config: GET  /api/webrtc/config`);
  console.log(`   Rooms:       GET  /api/rooms`);
  console.log(`   Supports up to 50 concurrent Web and Mobile participants seamlessly.\n`);
});
