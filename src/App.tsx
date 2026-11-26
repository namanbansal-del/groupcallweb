import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { CallMode } from './types';
import { useWebGroupCall } from './hooks/useWebGroupCall';
import { Lobby } from './components/Lobby';
import { ActiveCall } from './components/ActiveCall';
import { WaitingApprovalScreen } from './components/WaitingApprovalScreen';

export function App() {
  const [serverUrl, setServerUrl] = useState(() => {
    try {
      const saved = localStorage.getItem('groupcall_server_url');
      if (saved && !saved.includes('localhost') && !saved.includes('127.0.0.1')) {
        return saved;
      }
    } catch {}
    return (
      import.meta.env.VITE_SIGNALING_URL ||
      'https://tech.techugo.com:1065'
    );
  });

  const [currentUser, setCurrentUser] = useState(() => {
    let savedName: string | null = null;
    let savedId: string | null = null;
    try {
      const stored = localStorage.getItem('calling_currentUser');
      if (stored) {
        const u = JSON.parse(stored);
        if (u?.name) savedName = u.name;
        if (u?.id) savedId = u.id;
      }
      if (!savedName) {
        savedName = localStorage.getItem('groupcall_user_name');
      }
      // Persistent device user ID so page refreshes never spawn duplicate ghost participant IDs
      let deviceId = localStorage.getItem('groupcall_device_id');
      if (!deviceId) {
        deviceId = `usr_${Math.random().toString(36).substring(2, 9)}`;
        localStorage.setItem('groupcall_device_id', deviceId);
      }
      if (!savedId) {
        savedId = deviceId;
      }
    } catch {}
    return {
      id: savedId || `usr_${Math.random().toString(36).substring(2, 9)}`,
      name: savedName || 'Alex Johnson',
    };
  });

  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);

  // Manage socket connection cleanly with full lifecycle disconnect on cleanup
  useEffect(() => {
    let savedAuthToken: string | null = null;
    try {
      savedAuthToken = localStorage.getItem('calling_authToken');
    } catch {}

    const socketEndpoint = serverUrl.endsWith('/call') ? serverUrl : `${serverUrl}/call`;
    const s = io(socketEndpoint, {
      auth: {
        token: savedAuthToken,
      },
      autoConnect: true,
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 15,
      reconnectionDelay: 1500,
    });
    setSocket(s);

    const onConnect = () => setIsSocketConnected(true);
    const onDisconnect = () => setIsSocketConnected(false);
    const onConnectError = () => setIsSocketConnected(false);

    if (s.connected) {
      setIsSocketConnected(true);
    }

    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('connect_error', onConnectError);

    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.off('connect_error', onConnectError);
      s.disconnect();
    };
  }, [serverUrl]);

  const call = useWebGroupCall({
    socket,
    currentUser,
    serverUrl,
  });

  const handleUpdateServerUrl = (newUrl: string) => {
    if (!newUrl) return;
    const cleaned = newUrl.trim().replace(/\/+$/, '');
    try {
      localStorage.setItem('groupcall_server_url', cleaned);
    } catch {}
    setServerUrl(cleaned);
  };

  const handleJoin = async (
    roomId: string,
    name: string,
    mode: CallMode,
    cameraEnabled: boolean = true,
    micEnabled: boolean = true,
    existingStream?: MediaStream | null,
    isHost?: boolean
  ) => {
    const finalName = name.trim() || currentUser.name;
    setCurrentUser((prev) => ({ ...prev, name: finalName }));
    try {
      localStorage.setItem('groupcall_user_name', finalName);
    } catch {}
    await call.joinGroupCall(
      roomId,
      mode,
      finalName,
      cameraEnabled,
      micEnabled,
      existingStream,
      isHost
    );
  };

  const defaultRoomId =
    new URLSearchParams(window.location.search).get('room')?.toUpperCase() ||
    undefined;

  const isInCall =
    call.callState.status === 'joining' || call.callState.status === 'joined';

  const isWaitingApproval =
    call.callState.status === 'waiting_approval' || call.callState.status === 'denied';

  return (
    <div className={`app-root ${!isInCall && !isWaitingApproval ? 'in-lobby' : ''}`}>
      {isInCall ? (
        <ActiveCall call={call} />
      ) : isWaitingApproval ? (
        <WaitingApprovalScreen
          status={call.callState.status as 'waiting_approval' | 'denied'}
          roomId={call.callState.roomId}
          onReturnToLobby={call.leaveGroupCall}
        />
      ) : (
        <Lobby
          onJoin={handleJoin}
          defaultName={currentUser.name}
          defaultRoomId={defaultRoomId}
          serverUrl={serverUrl}
          onUpdateServerUrl={handleUpdateServerUrl}
          isSocketConnected={isSocketConnected}
        />
      )}
    </div>
  );
}

export default App;
