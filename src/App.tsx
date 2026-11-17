import { useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import type { CallMode } from './types';
import { useWebGroupCall } from './hooks/useWebGroupCall';
import { Lobby } from './components/Lobby';
import { ActiveCall } from './components/ActiveCall';

export function App() {
  const [serverUrl, setServerUrl] = useState(() => {
    return (
      localStorage.getItem('groupcall_server_url') ||
      import.meta.env.VITE_SIGNALING_URL ||
      'http://localhost:4000'
    );
  });

  const [currentUser, setCurrentUser] = useState(() => ({
    id: `web_user_${Math.floor(1000 + Math.random() * 9000)}`,
    name: 'Alex Johnson',
  }));

  const socket = useMemo(() => {
    return io(serverUrl, {
      autoConnect: true,
      transports: ['websocket'],
    });
  }, [serverUrl]);

  const call = useWebGroupCall({
    socket,
    currentUser,
    serverUrl,
  });

  const handleUpdateServerUrl = (newUrl: string) => {
    if (!newUrl) return;
    localStorage.setItem('groupcall_server_url', newUrl);
    setServerUrl(newUrl);
  };

  const handleJoin = async (roomId: string, name: string, mode: CallMode) => {
    setCurrentUser((prev) => ({ ...prev, name }));
    await call.joinGroupCall(roomId, mode);
  };

  const isInCall =
    call.callState.status === 'joining' || call.callState.status === 'joined';

  return (
    <div className="app-root">
      {isInCall ? (
        <ActiveCall call={call} />
      ) : (
        <Lobby
          onJoin={handleJoin}
          defaultName={currentUser.name}
          serverUrl={serverUrl}
          onUpdateServerUrl={handleUpdateServerUrl}
        />
      )}
    </div>
  );
}

export default App;

