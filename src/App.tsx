import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import type { CallMode } from './types';
import { useWebGroupCall } from './hooks/useWebGroupCall';
import { Lobby } from './components/Lobby';
import { ActiveCall } from './components/ActiveCall';

export function App() {
  const [serverUrl, setServerUrl] = useState(() => {
    const saved = localStorage.getItem('groupcall_server_url');
    if (saved && !saved.includes('localhost') && !saved.includes('127.0.0.1')) {
      return saved;
    }
    return (
      import.meta.env.VITE_SIGNALING_URL ||
      'https://tech.techugo.com:1065'
    );
  });

  const [currentUser, setCurrentUser] = useState(() => {
    const savedName = localStorage.getItem('groupcall_user_name');
    return {
      id: `web_user_${Math.floor(1000 + Math.random() * 9000)}`,
      name: savedName || 'Alex Johnson',
    };
  });

  const [isSocketConnected, setIsSocketConnected] = useState(false);

  const socket = useMemo(() => {
    return io(serverUrl, {
      autoConnect: true,
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1500,
    });
  }, [serverUrl]);

  useEffect(() => {
    if (!socket) return;
    const onConnect = () => setIsSocketConnected(true);
    const onDisconnect = () => setIsSocketConnected(false);
    const onConnectError = () => setIsSocketConnected(false);

    if (socket.connected) {
      setIsSocketConnected(true);
    } else {
      setIsSocketConnected(false);
    }

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
    };
  }, [socket]);

  const call = useWebGroupCall({
    socket,
    currentUser,
    serverUrl,
  });

  const handleUpdateServerUrl = (newUrl: string) => {
    if (!newUrl) return;
    const cleaned = newUrl.trim().replace(/\/+$/, '');
    localStorage.setItem('groupcall_server_url', cleaned);
    setServerUrl(cleaned);
  };

  const handleJoin = async (
    roomId: string,
    name: string,
    mode: CallMode,
    cameraEnabled: boolean = true,
    micEnabled: boolean = true,
    existingStream?: MediaStream | null
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
      existingStream
    );
  };

  const isInCall =
    call.callState.status === 'joining' || call.callState.status === 'joined';

  return (
    <div className={`app-root ${!isInCall ? 'in-lobby' : ''}`}>
      {isInCall ? (
        <ActiveCall call={call} />
      ) : (
        <Lobby
          onJoin={handleJoin}
          defaultName={currentUser.name}
          serverUrl={serverUrl}
          onUpdateServerUrl={handleUpdateServerUrl}
          isSocketConnected={isSocketConnected}
        />
      )}
    </div>
  );
}

export default App;
