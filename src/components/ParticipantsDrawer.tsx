import React, { useMemo, useState } from 'react';
import { X, Search, Mic, MicOff, Video, VideoOff, Hand, Edit2, Shield, UserMinus, MonitorOff, UserCheck, UserX, Crown } from 'lucide-react';
import type { Participant, KnockRequest } from '../types';

interface ParticipantsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  participants: Participant[];
  localParticipant: Participant;
  onOpenRename?: () => void;
  isHost?: boolean;
  onMuteParticipant?: (id: string) => void;
  onStopScreenShare?: (id: string) => void;
  onRemoveParticipant?: (id: string) => void;
  onMuteAll?: () => void;
  onOpenHostControls?: () => void;
  knockRequests?: KnockRequest[];
  onAdmit?: (socketId: string) => void;
  onDeny?: (socketId: string) => void;
  onMakeHost?: (socketId: string) => void;
}

export const ParticipantsDrawer: React.FC<ParticipantsDrawerProps> = ({
  isOpen,
  onClose,
  participants,
  localParticipant,
  onOpenRename,
  isHost = false,
  onMuteParticipant,
  onStopScreenShare,
  onRemoveParticipant,
  onMuteAll,
  onOpenHostControls,
  knockRequests = [],
  onAdmit,
  onDeny,
  onMakeHost,
}) => {
  const [search, setSearch] = useState('');

  const allUsers = useMemo(() => {
    const localId = localParticipant.id;
    const seenIds = new Set<string>([localId]);
    if (localParticipant.socketId) seenIds.add(localParticipant.socketId);
    if (localParticipant.userId) seenIds.add(localParticipant.userId);

    const dedupedRemotes: Participant[] = [];
    for (const p of participants) {
      if (!p || !p.id) continue;
      if (seenIds.has(p.id)) continue;
      if (p.socketId && seenIds.has(p.socketId)) continue;
      if (p.userId && seenIds.has(p.userId)) continue;

      seenIds.add(p.id);
      if (p.socketId) seenIds.add(p.socketId);
      if (p.userId) seenIds.add(p.userId);
      dedupedRemotes.push(p);
    }
    return [localParticipant, ...dedupedRemotes];
  }, [localParticipant, participants]);

  if (!isOpen) return null;

  const filtered = allUsers.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        {/* Drawer Header */}
        <div className="drawer-header">
          <div>
            <h2 className="drawer-title">Participants</h2>
            <p className="drawer-subtitle">
              {allUsers.length} connected (up to 50 support)
            </p>
          </div>
          <button className="drawer-close-btn" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {/* Search Input */}
        <div className="drawer-search-wrap">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            className="drawer-search-input"
            placeholder="Search participants by name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="search-clear-btn" onClick={() => setSearch('')}>
              <X size={14} />
            </button>
          )}
        </div>

        {/* Host Quick Toolbar */}
        {isHost && (
          <div className="drawer-host-toolbar">
            <button
              type="button"
              className="btn-drawer-mute-all"
              onClick={onMuteAll}
              title="Mute all participants"
            >
              <MicOff size={14} />
              <span>Mute All</span>
            </button>
            <button
              type="button"
              className="btn-drawer-host-settings"
              onClick={onOpenHostControls}
              title="Open host controls and permissions"
            >
              <Shield size={14} />
              <span>Host Controls</span>
            </button>
          </div>
        )}

        {/* Waiting to Join (Knock requests for Host) */}
        {isHost && knockRequests.length > 0 && (
          <div className="drawer-waiting-section">
            <div className="drawer-waiting-header">
              <span className="drawer-waiting-title">Waiting to join ({knockRequests.length})</span>
            </div>
            <div className="drawer-waiting-list">
              {knockRequests.map((req) => (
                <div key={req.socketId} className="drawer-waiting-row">
                  <div className="drawer-waiting-user">
                    <div className="participant-avatar waiting-avatar">
                      <span>{req.userName.charAt(0).toUpperCase()}</span>
                    </div>
                    <span className="drawer-waiting-name">{req.userName}</span>
                  </div>
                  <div className="drawer-waiting-actions">
                    <button
                      type="button"
                      className="btn-drawer-deny"
                      title="Deny entry"
                      onClick={() => onDeny && onDeny(req.socketId)}
                    >
                      <UserX size={15} />
                      <span>Deny</span>
                    </button>
                    <button
                      type="button"
                      className="btn-drawer-admit"
                      title="Admit into call"
                      onClick={() => onAdmit && onAdmit(req.socketId)}
                    >
                      <UserCheck size={15} />
                      <span>Admit</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Participant List */}
        <div className="drawer-list">
          {filtered.length === 0 ? (
            <div className="drawer-empty">No participants match "{search}"</div>
          ) : (
            filtered.map((p) => {
              const isLocal =
                p.id === localParticipant.id ||
                (p.socketId && p.socketId === localParticipant.socketId) ||
                (p.userId && p.userId === localParticipant.userId);
              const initial = p.name ? p.name.slice(0, 1).toUpperCase() : '?';

              return (
                <div key={p.id} className="participant-row">
                  <div className="participant-info">
                    <div className="participant-avatar">
                      <span>{initial}</span>
                    </div>
                    <div>
                      <div className="participant-row-name">
                        <span>{p.name}</span>
                        {isLocal && (
                          <>
                            <span className="tag-you">(You)</span>
                            {onOpenRename && (
                              <button
                                type="button"
                                onClick={onOpenRename}
                                title="Change name"
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  padding: '2px',
                                  color: '#64748B',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                }}
                              >
                                <Edit2 size={12} />
                              </button>
                            )}
                          </>
                        )}
                        {p.isHost && <span className="tag-host">Host</span>}
                      </div>
                      <div className="participant-row-status">
                        {p.isSpeaking && !p.isMuted ? (
                          <span className="status-speaking">Speaking</span>
                        ) : p.isMuted ? (
                          <span className="status-muted">Muted</span>
                        ) : isLocal || p.stream ? (
                          <span className="drawer-status-connected">Connected</span>
                        ) : (
                          <span style={{ color: '#94A3B8' }}>Offline / Idle</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Actions & Status Icons */}
                  <div className="participant-icons">
                    {p.isHandRaised && (
                      <span className="icon-badge-hand" title="Hand Raised">
                        <Hand size={14} />
                      </span>
                    )}

                    {p.isCameraOff ? (
                      <span className="icon-badge-off" title="Camera Off">
                        <VideoOff size={15} color="#94A3B8" />
                      </span>
                    ) : (
                      <span className="icon-badge-on" title="Camera On">
                        <Video size={15} color="#2563EB" />
                      </span>
                    )}

                    {p.isMuted ? (
                      <span className="icon-badge-danger" title="Microphone Muted">
                        <MicOff size={15} color="#EF4444" />
                      </span>
                    ) : (
                      <span className="icon-badge-on" title="Microphone Active">
                        <Mic size={15} color="#10B981" />
                      </span>
                    )}

                    {/* Host Participant Action Buttons */}
                    {isHost && !isLocal && (
                      <div className="host-row-actions">
                        {onMakeHost && !p.isHost && (
                          <button
                            type="button"
                            className="btn-host-action btn-host-make-host"
                            onClick={() => {
                              if (window.confirm(`Transfer meeting host role to ${p.name}?`)) {
                                onMakeHost(p.socketId || p.id);
                              }
                            }}
                            title={`Make ${p.name} Host`}
                          >
                            <Crown size={13} color="#F59E0B" />
                          </button>
                        )}
                        {!p.isMuted && onMuteParticipant && (
                          <button
                            type="button"
                            className="btn-host-action btn-host-mute"
                            onClick={() => onMuteParticipant(p.id)}
                            title={`Mute ${p.name}`}
                          >
                            <MicOff size={13} />
                          </button>
                        )}
                        {p.isScreenSharing && onStopScreenShare && (
                          <button
                            type="button"
                            className="btn-host-action btn-host-stop-share"
                            onClick={() => onStopScreenShare(p.id)}
                            title={`Stop ${p.name}'s screen sharing`}
                          >
                            <MonitorOff size={13} />
                          </button>
                        )}
                        {onRemoveParticipant && (
                          <button
                            type="button"
                            className="btn-host-action btn-host-remove"
                            onClick={() => {
                              if (window.confirm(`Remove ${p.name} from the call?`)) {
                                onRemoveParticipant(p.id);
                              }
                            }}
                            title={`Remove ${p.name} from meeting`}
                          >
                            <UserMinus size={13} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
};
