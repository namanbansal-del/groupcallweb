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
  {
    urls: [
      'stun:13.126.239.227:3478',
      'stun:stun.l.google.com:19302',
    ],
  },
  {
    urls: [
      'turn:13.126.239.227:3478?transport=udp',
      'turn:13.126.239.227:3478?transport=tcp',
    ],
    username: 'turnuser',
    credential: 'techugo@123',
  },
];

// Room & Socket State
const rooms = new Map(); // roomCode -> Map<socketId, { socketId, userId, userName, isMuted, isCameraOff }>
const socketMeta = new Map(); // socketId -> { roomCode, userId, userName }
const roomMeta = new Map(); // roomCode -> { hostSocketId, requireApprovalToJoin, pendingKnocks: Map<socketId, { socketId, userId, userName, payload }> }

// In-Memory User Auth Store
const usersByPhone = new Map(); // phone -> { id, name, phone, password, createdAt }
const usersById = new Map(); // id -> user
const tokensMap = new Map(); // token -> user

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

function parseRequestBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2e6) req.destroy();
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ── AUTH ENDPOINTS ─────────────────────────────────────────────
  // POST /api/calling/signup
  if (req.method === 'POST' && url.pathname === '/api/calling/signup') {
    const data = await parseRequestBody(req);
    const { name, phone, password } = data;
    if (!phone) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Phone number or email is required' }));
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
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Signup successful',
      user: { id: user.id, name: user.name, phone: user.phone },
      token,
    }));
    return;
  }

  // POST /api/calling/login
  if (req.method === 'POST' && url.pathname === '/api/calling/login') {
    const data = await parseRequestBody(req);
    const { phone, password } = data;
    if (!phone) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Phone number or email is required' }));
      return;
    }
    const cleanPhone = String(phone).trim();
    let user = usersByPhone.get(cleanPhone);
    if (!user) {
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
    res.end(JSON.stringify({
      success: true,
      message: 'Login successful',
      user: { id: user.id, name: user.name, phone: user.phone },
      token,
    }));
    return;
  }

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
  pingTimeout: 10000,
  pingInterval: 5000,
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

    // ── 1. JOIN ROOM ───────────────────────────────────────────────
    const handleJoin = (payload = {}, ackCallback) => {
      const roomCode = (payload.roomCode || payload.roomId || STATIC_ROOM_CODE).trim().toUpperCase();
      const userName = payload.userName || payload.name || payload.user?.name || socket.user?.name || `User_${socket.id.slice(0, 4)}`;
      const userId = payload.userId || payload.user?.id || socket.user?.id || `user_${socket.id.slice(0, 6)}`;
      const isHost = Boolean(payload.isHost);
      const isAdmitted = Boolean(payload.isAdmitted);

      // Track room host metadata & approval settings
      let meta = roomMeta.get(roomCode);
      const isRoomEmpty = !rooms.has(roomCode) || rooms.get(roomCode).size === 0;
      if (!meta) {
        meta = {
          hostSocketId: socket.id, // First user joining is automatically Host
          requireApprovalToJoin: isHost, // by default enable approval if started by a host
          pendingKnocks: new Map(),
          startedAt: Date.now(), // Synced meeting room start time
        };
        roomMeta.set(roomCode, meta);
      } else {
        if (!meta.startedAt) meta.startedAt = Date.now();
        if (isRoomEmpty) {
          meta.hostSocketId = socket.id;
          meta.startedAt = Date.now();
        } else if (isHost && !meta.hostSocketId) {
          meta.hostSocketId = socket.id;
        }
      }

      // Check if room requires host approval and user is not yet admitted
      if (meta.hostSocketId && meta.requireApprovalToJoin && !isHost && meta.hostSocketId !== socket.id && !isAdmitted) {
        const hostSocket = io.of('/').sockets.get(meta.hostSocketId) || io.of('/call').sockets.get(meta.hostSocketId);
        if (hostSocket && hostSocket.connected) {
          console.log(`[Waiting Room] ${userName} (${socket.id}) knocking to join '${roomCode}'`);
          meta.pendingKnocks.set(socket.id, { socketId: socket.id, userId, userName, payload });

          // Send knock request to the host
          hostSocket.emit('room:knock-request', {
            socketId: socket.id,
            userId,
            userName,
            roomCode,
          });

          // Tell joiner to wait for approval
          socket.emit('room:waiting-approval', { roomCode });

          if (typeof ackCallback === 'function') {
            ackCallback({ ok: true, status: 'waiting_approval', roomCode });
          }
          return;
        }
      }

      socket.join(roomCode);

      if (!rooms.has(roomCode)) {
        rooms.set(roomCode, new Map());
      }
      const room = rooms.get(roomCode);

      // Auto-prune ghost sockets: If this user already exists from a prior connection (e.g. page refresh),
      // prune the stale socket immediately and notify all participants!
      for (const [existingSid, existingP] of room.entries()) {
        if (
          existingSid !== socket.id &&
          (existingP.userId === userId ||
            (existingP.userName &&
              existingP.userName === userName &&
              (userName.startsWith('User_') || !userName.includes(' '))))
        ) {
          console.log(`[Join Room] Pruning ghost participant ${existingSid} (${existingP.userName}) for newly connected socket ${socket.id}`);
          room.delete(existingSid);
          socketMeta.delete(existingSid);
          const pruneEvt = { socketId: existingSid, userId: existingP.userId, userName: existingP.userName, remainingCount: room.size };
          namespace.to(roomCode).emit('user-disconnected', pruneEvt);
          io.of('/').to(roomCode).emit('user-disconnected', pruneEvt);
          io.of('/call').to(roomCode).emit('user-disconnected', pruneEvt);
          io.of('/').to(roomCode).emit('user-left', pruneEvt);
          io.of('/call').to(roomCode).emit('user-left', pruneEvt);
        }
      }

      // Collect existing users to send to the joiner, filtering out any dead sockets
      const existingUsers = [];
      const legacyPeers = [];
      for (const [sid, existing] of room.entries()) {
        const liveSocket = io.of('/').sockets.get(sid) || io.of('/call').sockets.get(sid);
        if (liveSocket && !liveSocket.connected) {
          room.delete(sid);
          continue;
        }
        existingUsers.push({
          socketId: existing.socketId,
          userName: existing.userName,
          userId: existing.userId,
          isMuted: existing.isMuted,
          isCameraOff: existing.isCameraOff,
          isHost: meta.hostSocketId === existing.socketId,
        });
        legacyPeers.push({
          id: existing.socketId,
          name: existing.userName,
          isMuted: existing.isMuted,
          isCameraOff: existing.isCameraOff,
          isHost: meta.hostSocketId === existing.socketId,
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
      socket.emit('all-users', {
        users: existingUsers,
        startedAt: meta.startedAt,
        hostSocketId: meta.hostSocketId,
      });
      // B. Backward-compatible event to joiner
      socket.emit('room:peers', {
        peers: legacyPeers,
        startedAt: meta.startedAt,
        hostSocketId: meta.hostSocketId,
      });

      // C. Broadcast to existing users in room
      const connData = {
        socketId: socket.id,
        userName,
        userId,
        isHost: meta.hostSocketId === socket.id,
        totalUsers: room.size,
      };
      socket.to(roomCode).emit('user-connected', connData);
      io.of('/').to(roomCode).emit('user-connected', connData);
      io.of('/call').to(roomCode).emit('user-connected', connData);

      // Backward-compatible
      socket.to(roomCode).emit('peer:joined', {
        user: { id: socket.id, name: userName, isHost: meta.hostSocketId === socket.id },
      });

      console.log(`[Join Room] ${userName} (${socket.id}) in '${roomCode}' (Host: ${meta.hostSocketId === socket.id ? 'YES' : 'NO'}). Total: ${room.size}`);

      if (typeof ackCallback === 'function') {
        ackCallback({
          ok: true,
          roomCode,
          totalUsers: room.size,
          startedAt: meta.startedAt,
          hostSocketId: meta.hostSocketId,
          peerInfo: { isHost: meta.hostSocketId === socket.id },
        });
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
      let matchedSid = targetId;
      for (const [sid, p] of room.entries()) {
        if (sid === targetId || p.userId === targetId || p.socketId === targetId) {
          p.isMuted = true;
          matchedSid = sid;
          break;
        }
      }
      const muteData = {
        socketId: matchedSid,
        targetId,
        userId: targetId,
        id: matchedSid,
        enabled: false,
        isMuted: true,
      };
      namespace.to(roomCode).emit('host:mute-user', muteData);
      namespace.to(roomCode).emit('peer:toggle-audio', muteData);
      namespace.to(roomCode).emit('toggle-audio', muteData);
      namespace.to(roomCode).emit('peer:media-toggle', {
        userId: targetId,
        socketId: matchedSid,
        isMuted: true,
        isCameraOff: false,
      });

      io.of('/').to(roomCode).emit('host:mute-user', muteData);
      io.of('/').to(roomCode).emit('peer:toggle-audio', muteData);
      io.of('/').to(roomCode).emit('toggle-audio', muteData);
      io.of('/').to(roomCode).emit('peer:media-toggle', {
        userId: targetId,
        socketId: matchedSid,
        isMuted: true,
        isCameraOff: false,
      });

      io.of('/call').to(roomCode).emit('host:mute-user', muteData);
      io.of('/call').to(roomCode).emit('peer:toggle-audio', muteData);
      io.of('/call').to(roomCode).emit('toggle-audio', muteData);
      io.of('/call').to(roomCode).emit('peer:media-toggle', {
        userId: targetId,
        socketId: matchedSid,
        isMuted: true,
        isCameraOff: false,
      });
      console.log(`[Host Control] Host ${socket.id} muted participant ${targetId} in '${roomCode}'`);
    });

    // Host can mute everyone (Supports both 'mute-all' and 'host:mute-all')
    const handleMuteAll = (payload = {}) => {
      const { roomId } = payload || {};
      const roomCode = (roomId || (socketMeta.get(socket.id)?.roomCode) || '').toUpperCase();
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room) return;

      for (const [sid, p] of room.entries()) {
        if (sid !== socket.id) {
          p.isMuted = true;
        }
      }

      const muteAllPayload = { hostSocketId: socket.id, roomCode };
      // Broadcast force-mute and host:mute-all across namespaces
      namespace.to(roomCode).emit('force-mute', muteAllPayload);
      io.of('/').to(roomCode).emit('force-mute', muteAllPayload);
      io.of('/call').to(roomCode).emit('force-mute', muteAllPayload);

      namespace.to(roomCode).emit('host:mute-all', muteAllPayload);
      io.of('/').to(roomCode).emit('host:mute-all', muteAllPayload);
      io.of('/call').to(roomCode).emit('host:mute-all', muteAllPayload);

      // Explicitly broadcast toggle-audio for every muted participant so UI badges immediately update
      for (const [sid, p] of room.entries()) {
        if (sid !== socket.id) {
          const muteData = {
            socketId: sid,
            userId: p.userId,
            id: sid,
            enabled: false,
            isMuted: true,
          };
          namespace.to(roomCode).emit('peer:toggle-audio', muteData);
          namespace.to(roomCode).emit('toggle-audio', muteData);
          namespace.to(roomCode).emit('peer:media-toggle', {
            userId: p.userId || sid,
            socketId: sid,
            isMuted: true,
            isCameraOff: p.isCameraOff || false,
          });

          io.of('/').to(roomCode).emit('peer:toggle-audio', muteData);
          io.of('/').to(roomCode).emit('toggle-audio', muteData);
          io.of('/').to(roomCode).emit('peer:media-toggle', {
            userId: p.userId || sid,
            socketId: sid,
            isMuted: true,
            isCameraOff: p.isCameraOff || false,
          });

          io.of('/call').to(roomCode).emit('peer:toggle-audio', muteData);
          io.of('/call').to(roomCode).emit('toggle-audio', muteData);
          io.of('/call').to(roomCode).emit('peer:media-toggle', {
            userId: p.userId || sid,
            socketId: sid,
            isMuted: true,
            isCameraOff: p.isCameraOff || false,
          });
        }
      }
      console.log(`[Host Control] Host ${socket.id} muted all participants in '${roomCode}'`);
    };

    socket.on('mute-all', handleMuteAll);
    socket.on('host:mute-all', handleMuteAll);

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

    // Host can update meeting permissions (Supports both 'update-host-controls' and 'host:settings-update')
    const handleUpdateHostControls = (payload = {}) => {
      const { settings, roomId } = payload || {};
      const roomCode = (roomId || (socketMeta.get(socket.id)?.roomCode) || '').toUpperCase();
      if (!roomCode) return;
      const meta = roomMeta.get(roomCode);
      const rawSettings = settings || payload || {};

      const allowMic = typeof rawSettings.allowMic === 'boolean'
        ? rawSettings.allowMic
        : (typeof rawSettings.allowUnmute === 'boolean' ? rawSettings.allowUnmute : true);
      const allowVideo = typeof rawSettings.allowVideo === 'boolean'
        ? rawSettings.allowVideo
        : (typeof rawSettings.allowCamera === 'boolean' ? rawSettings.allowCamera : true);
      const allowScreenShare = typeof rawSettings.allowScreenShare === 'boolean'
        ? rawSettings.allowScreenShare
        : true;
      const allowChat = typeof rawSettings.allowChat === 'boolean'
        ? rawSettings.allowChat
        : true;
      const waitingRoom = typeof rawSettings.waitingRoom === 'boolean'
        ? rawSettings.waitingRoom
        : (typeof rawSettings.requireApprovalToJoin === 'boolean' ? rawSettings.requireApprovalToJoin : false);

      const normalizedSettings = {
        allowScreenShare,
        allowChat,
        allowMic,
        allowUnmute: allowMic,
        allowVideo,
        allowCamera: allowVideo,
        waitingRoom,
        requireApprovalToJoin: waitingRoom,
      };

      if (meta) {
        meta.requireApprovalToJoin = waitingRoom;
      }

      // Broadcast across all namespaces and event aliases
      namespace.to(roomCode).emit('host-controls-updated', { settings: normalizedSettings });
      io.of('/').to(roomCode).emit('host-controls-updated', { settings: normalizedSettings });
      io.of('/call').to(roomCode).emit('host-controls-updated', { settings: normalizedSettings });

      namespace.to(roomCode).emit('peer:host-settings', { settings: normalizedSettings });
      io.of('/').to(roomCode).emit('peer:host-settings', { settings: normalizedSettings });
      io.of('/call').to(roomCode).emit('peer:host-settings', { settings: normalizedSettings });

      namespace.to(roomCode).emit('host:settings-update', { settings: normalizedSettings });
      io.of('/').to(roomCode).emit('host:settings-update', { settings: normalizedSettings });
      io.of('/call').to(roomCode).emit('host:settings-update', { settings: normalizedSettings });
      console.log(`[Host Control] Host ${socket.id} updated controls in '${roomCode}':`, normalizedSettings);
    };

    socket.on('update-host-controls', handleUpdateHostControls);
    socket.on('host:settings-update', handleUpdateHostControls);
    socket.on('peer:host-settings', handleUpdateHostControls);

    // Host admits a participant waiting in waiting room
    socket.on('host:admit-entry', (payload = {}) => {
      const { targetId, roomId } = payload;
      const roomCode = (roomId || (socketMeta.get(socket.id)?.roomCode) || '').toUpperCase();
      if (!roomCode || !targetId) return;

      const meta = roomMeta.get(roomCode);
      if (meta && meta.pendingKnocks?.has(targetId)) {
        meta.pendingKnocks.delete(targetId);
      }

      const targetSocket = io.of('/').sockets.get(targetId) || io.of('/call').sockets.get(targetId);
      if (targetSocket) {
        console.log(`[Waiting Room] Host admitted ${targetId} into '${roomCode}'`);
        targetSocket.emit('room:admitted', { roomCode });
      }
    });

    // Host denies a participant waiting in waiting room
    socket.on('host:deny-entry', (payload = {}) => {
      const { targetId, roomId } = payload;
      const roomCode = (roomId || (socketMeta.get(socket.id)?.roomCode) || '').toUpperCase();
      if (!roomCode || !targetId) return;

      const meta = roomMeta.get(roomCode);
      if (meta && meta.pendingKnocks?.has(targetId)) {
        meta.pendingKnocks.delete(targetId);
      }

      const targetSocket = io.of('/').sockets.get(targetId) || io.of('/call').sockets.get(targetId);
      if (targetSocket) {
        console.log(`[Waiting Room] Host denied entry for ${targetId} into '${roomCode}'`);
        targetSocket.emit('room:denied', { roomCode });
      }
    });

    // ── Host Transfer (Make another participant Host) ──────────────
    socket.on('make-host', (payload = {}, ackCallback) => {
      const targetSocketId = payload.targetSocketId || payload.targetId;
      const meta = socketMeta.get(socket.id);
      if (!meta) return;
      const rMeta = roomMeta.get(meta.roomCode);
      if (!rMeta || rMeta.hostSocketId !== socket.id) {
        if (typeof ackCallback === 'function') {
          ackCallback({ ok: false, error: 'Only current host can transfer host role' });
        }
        return;
      }
      const room = rooms.get(meta.roomCode);
      if (!room || !room.has(targetSocketId)) {
        if (typeof ackCallback === 'function') {
          ackCallback({ ok: false, error: 'Target participant not found in room' });
        }
        return;
      }
      rMeta.hostSocketId = targetSocketId;
      const targetUser = room.get(targetSocketId);
      const hostChangedData = {
        newHost: {
          socketId: targetSocketId,
          userId: targetUser.userId,
          userName: targetUser.userName,
        },
        previousHostSocketId: socket.id,
        roomCode: meta.roomCode,
      };
      namespace.to(meta.roomCode).emit('host-changed', hostChangedData);
      io.of('/').to(meta.roomCode).emit('host-changed', hostChangedData);
      io.of('/call').to(meta.roomCode).emit('host-changed', hostChangedData);
      if (typeof ackCallback === 'function') {
        ackCallback({ ok: true, newHostSocketId: targetSocketId });
      }
      console.log(`[Host Transfer] ${socket.id} transferred host to ${targetUser.userName} (${targetSocketId}) in '${meta.roomCode}'`);
    });

    // ── 7. LEAVE / DISCONNECT (Ghost Participant Cleanup) ──────────
    const handleLeave = () => {
      const meta = socketMeta.get(socket.id);
      if (!meta) return;
      const { roomCode, userName, userId } = meta;
      const room = rooms.get(roomCode);

      if (room) {
        room.delete(socket.id);
        const remainingCount = room.size;

        const dcEvent = {
          socketId: socket.id,
          userId: userId || socket.id,
          userName,
          remainingCount,
        };

        // Broadcast cleanup events across BOTH namespaces so every connected participant receives it
        namespace.to(roomCode).emit('user-disconnected', dcEvent);
        io.of('/').to(roomCode).emit('user-disconnected', dcEvent);
        io.of('/call').to(roomCode).emit('user-disconnected', dcEvent);
        io.of('/').to(roomCode).emit('user-left', dcEvent);
        io.of('/call').to(roomCode).emit('user-left', dcEvent);
        io.of('/').to(roomCode).emit('peer:left', { userId: userId || socket.id, socketId: socket.id });
        io.of('/call').to(roomCode).emit('peer:left', { userId: userId || socket.id, socketId: socket.id });
        io.of('/').to(roomCode).emit('participant-left', dcEvent);
        io.of('/call').to(roomCode).emit('participant-left', dcEvent);

        if (room.size === 0) {
          rooms.delete(roomCode);
        }
        console.log(`[User Left] ${userName} (${socket.id}) from '${roomCode}'. Remaining: ${remainingCount}`);
      }

      // Cleanup host status, auto-reassign host if host leaves, and auto-admit any pending knocks
      const rMeta = roomMeta.get(roomCode);
      if (rMeta && rMeta.hostSocketId === socket.id) {
        if (room && room.size > 0) {
          const nextPeer = Array.from(room.values())[0];
          rMeta.hostSocketId = nextPeer.socketId;
          const hostChangedData = {
            newHost: {
              socketId: nextPeer.socketId,
              userId: nextPeer.userId,
              userName: nextPeer.userName,
            },
            previousHostSocketId: socket.id,
            roomCode,
          };
          namespace.to(roomCode).emit('host-changed', hostChangedData);
          io.of('/').to(roomCode).emit('host-changed', hostChangedData);
          io.of('/call').to(roomCode).emit('host-changed', hostChangedData);
          console.log(`[Host Auto-Reassign] Transferred host to ${nextPeer.userName} (${nextPeer.socketId}) in '${roomCode}'`);
        } else {
          rMeta.hostSocketId = null;
        }

        if (rMeta.pendingKnocks) {
          for (const [waitingSid] of rMeta.pendingKnocks.entries()) {
            const targetSocket = io.of('/').sockets.get(waitingSid) || io.of('/call').sockets.get(waitingSid);
            if (targetSocket) targetSocket.emit('room:admitted', { roomCode });
          }
          rMeta.pendingKnocks.clear();
        }
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

// Periodic Zombie Socket Reaper (Every 5 seconds)
// Purges any dropped or abruptly closed sockets that missed a disconnect event
setInterval(() => {
  for (const [roomCode, room] of rooms.entries()) {
    for (const [sid, p] of room.entries()) {
      const liveSocket = io.of('/').sockets.get(sid) || io.of('/call').sockets.get(sid);
      if (!liveSocket || !liveSocket.connected) {
        console.log(`[Zombie Reaper] Removing dead socket ${sid} (${p.userName}) from '${roomCode}'`);
        room.delete(sid);
        socketMeta.delete(sid);
        const dcEvent = { socketId: sid, userId: p.userId, userName: p.userName, remainingCount: room.size };
        io.of('/').to(roomCode).emit('user-disconnected', dcEvent);
        io.of('/call').to(roomCode).emit('user-disconnected', dcEvent);
        io.of('/').to(roomCode).emit('user-left', dcEvent);
        io.of('/call').to(roomCode).emit('user-left', dcEvent);
      }
    }
    if (room.size === 0) {
      rooms.delete(roomCode);
    }
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`\n🚀 GroupCall Multi-User Google Meet Signaling Server running on http://localhost:${PORT}`);
  console.log(`   Namespaces: '/' and '/call'`);
  console.log(`   REST Config: GET  /api/webrtc/config`);
  console.log(`   Rooms:       GET  /api/rooms`);
  console.log(`   Supports up to 50 concurrent Web and Mobile participants.\n`);
});
