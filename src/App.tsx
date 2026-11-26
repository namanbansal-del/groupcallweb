import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { CallMode } from './types';
import { useWebGroupCall } from './hooks/useWebGroupCall';
import { Lobby } from './components/Lobby';
import { ActiveCall } from './components/ActiveCall';

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
    try {
      savedName = localStorage.getItem('groupcall_user_name');
    } catch {}
    return {
      id: `web_user_${Math.floor(1000 + Math.random() * 9000)}`,
      name: savedName || 'Alex Johnson',
    };
  });

  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);

  // Manage socket connection cleanly with full lifecycle disconnect on cleanup
  useEffect(() => {
    const s = io(serverUrl, {
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

  return (
    <div className={`app-root ${!isInCall ? 'in-lobby' : ''}`}>
      {isInCall ? (
        <ActiveCall call={call} />
      ) : (
        <Lobby
          socket={socket}
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
