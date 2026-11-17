import { useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import type { CallMode } from './types';
import { useWebGroupCall } from './hooks/useWebGroupCall';
import { Lobby } from './components/Lobby';
import { ActiveCall } from './components/ActiveCall';

// Connect to the shared signaling server (works seamlessly with the mobile app!)
const SIGNALING_SERVER_URL =
  import.meta.env.VITE_SIGNALING_URL || 'http://localhost:3000';

export function App() {
  const [currentUser, setCurrentUser] = useState(() => ({
    id: `web_user_${Math.floor(1000 + Math.random() * 9000)}`,
    name: 'Alex Johnson',
  }));

  const socket = useMemo(() => {
    return io(SIGNALING_SERVER_URL, {
      autoConnect: true,
      transports: ['websocket'],
    });
  }, []);

  const call = useWebGroupCall({
    socket,
    currentUser,
  });

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
        <Lobby onJoin={handleJoin} defaultName={currentUser.name} />
      )}
    </div>
  );
}

export default App;
