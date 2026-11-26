export type CallMode = 'audio' | 'video';

export type CallStatus = 'idle' | 'joining' | 'waiting_approval' | 'denied' | 'joined' | 'left';

export interface Participant {
  id: string;
  socketId?: string;
  userId?: string;
  name: string;
  avatar?: string;
  isMuted: boolean;
  isCameraOff: boolean;
  isSpeaking?: boolean;
  isHandRaised?: boolean;
  isScreenSharing?: boolean;
  isHost?: boolean;
  stream?: MediaStream | null;
  screenStream?: MediaStream | null;
}

export interface HostSettings {
  allowScreenShare: boolean;
  allowChat: boolean;
  allowUnmute: boolean;
  allowCamera: boolean;
  requireApprovalToJoin: boolean;
}

export interface KnockRequest {
  socketId: string;
  userId: string;
  userName: string;
}

export interface GroupCallState {
  roomId: string | null;
  mode: CallMode;
  status: CallStatus;
  participants: Participant[];
  localParticipant: Participant;
  activeSpeakerId: string | null;
  isMuted: boolean;
  isCameraOff: boolean;
  isHandRaised: boolean;
  isScreenSharing: boolean;
  isHost: boolean;
  hostSettings: HostSettings;
  hostNotification: string | null;
  knockRequests: KnockRequest[];
  durationSec: number;
  error: string | null;
}

