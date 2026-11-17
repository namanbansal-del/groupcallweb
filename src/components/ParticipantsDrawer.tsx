import React, { useState } from 'react';
import { X, Search, Mic, MicOff, Video, VideoOff, Hand } from 'lucide-react';
import type { Participant } from '../types';

interface ParticipantsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  participants: Participant[];
  localParticipant: Participant;
}

export const ParticipantsDrawer: React.FC<ParticipantsDrawerProps> = ({
  isOpen,
  onClose,
  participants,
  localParticipant,
}) => {
  const [search, setSearch] = useState('');

  if (!isOpen) return null;

  const allUsers = [localParticipant, ...participants];
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

        {/* Participant List */}
        <div className="drawer-list">
          {filtered.length === 0 ? (
            <div className="drawer-empty">No participants match "{search}"</div>
          ) : (
            filtered.map((p) => {
              const isLocal = p.id === localParticipant.id;
              const initial = p.name ? p.name.slice(0, 1).toUpperCase() : '?';

              return (
                <div key={p.id} className="participant-row">
                  <div className="participant-info">
                    <div className="participant-avatar">
                      <span>{initial}</span>
                    </div>
                    <div>
                      <div className="participant-row-name">
                        {p.name} {isLocal && <span className="tag-you">(You)</span>}
                        {p.isHost && <span className="tag-host">Host</span>}
                      </div>
                      <div className="participant-row-status">
                        {p.isSpeaking && !p.isMuted ? (
                          <span className="status-speaking">Speaking</span>
                        ) : p.isMuted ? (
                          <span className="status-muted">Muted</span>
                        ) : (
                          <span className="status-connected">Connected</span>
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
