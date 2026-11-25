import React from 'react';
import { X, Shield, MicOff, MonitorUp, MessageSquare, Mic, Video } from 'lucide-react';
import type { HostSettings } from '../types';

interface HostControlsModalProps {
  isOpen: boolean;
  onClose: () => void;
  hostSettings: HostSettings;
  onUpdateSettings: (newSettings: Partial<HostSettings>) => void;
  onMuteAll: () => void;
  participantCount: number;
}

export const HostControlsModal: React.FC<HostControlsModalProps> = ({
  isOpen,
  onClose,
  hostSettings,
  onUpdateSettings,
  onMuteAll,
  participantCount,
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="host-controls-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Host management"
      >
        <div className="sheet-handle" />

        {/* Modal Header */}
        <div className="host-modal-header">
          <div className="host-header-info">
            <div className="host-shield-badge">
              <Shield size={20} color="#2563EB" />
            </div>
            <div>
              <h2 className="host-modal-title">Host controls</h2>
              <p className="host-modal-desc">
                Use these host settings to maintain full control of your meeting
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn-modal-close"
            onClick={onClose}
            aria-label="Close host controls"
          >
            <X size={20} />
          </button>
        </div>

        {/* Quick Action: Mute All */}
        <div className="host-section">
          <h3 className="host-section-title">Quick Actions</h3>
          <div className="host-mute-all-card">
            <div className="host-mute-all-info">
              <div className="mute-icon-circle">
                <MicOff size={18} color="#EF4444" />
              </div>
              <div>
                <span className="mute-all-heading">Mute all participants</span>
                <span className="mute-all-sub">
                  Mutes everyone in the call except you ({Math.max(1, participantCount)} total connected)
                </span>
              </div>
            </div>
            <button
              type="button"
              className="btn-host-mute-all"
              onClick={() => {
                onMuteAll();
              }}
            >
              Mute All
            </button>
          </div>
        </div>

        {/* Participant Permissions (Google Meet Style) */}
        <div className="host-section">
          <h3 className="host-section-title">Let everyone in this call:</h3>
          <div className="host-toggles-list">
            {/* 1. Share screen */}
            <div className="host-toggle-row">
              <div className="host-toggle-item-info">
                <div className="toggle-icon-wrap">
                  <MonitorUp size={18} color="#94A3B8" />
                </div>
                <div>
                  <span className="toggle-item-title">Share their screen</span>
                  <span className="toggle-item-desc">
                    Allow participants to present and share screens
                  </span>
                </div>
              </div>
              <label className="switch-toggle">
                <input
                  type="checkbox"
                  checked={hostSettings.allowScreenShare}
                  onChange={(e) =>
                    onUpdateSettings({ allowScreenShare: e.target.checked })
                  }
                />
                <span className="switch-slider" />
              </label>
            </div>

            {/* 2. Send chat messages */}
            <div className="host-toggle-row">
              <div className="host-toggle-item-info">
                <div className="toggle-icon-wrap">
                  <MessageSquare size={18} color="#94A3B8" />
                </div>
                <div>
                  <span className="toggle-item-title">Send chat messages</span>
                  <span className="toggle-item-desc">
                    Allow participants to send in-call chat messages
                  </span>
                </div>
              </div>
              <label className="switch-toggle">
                <input
                  type="checkbox"
                  checked={hostSettings.allowChat}
                  onChange={(e) => onUpdateSettings({ allowChat: e.target.checked })}
                />
                <span className="switch-slider" />
              </label>
            </div>

            {/* 3. Turn on their microphone */}
            <div className="host-toggle-row">
              <div className="host-toggle-item-info">
                <div className="toggle-icon-wrap">
                  <Mic size={18} color="#94A3B8" />
                </div>
                <div>
                  <span className="toggle-item-title">Turn on their microphone</span>
                  <span className="toggle-item-desc">
                    Allow participants to unmute and speak
                  </span>
                </div>
              </div>
              <label className="switch-toggle">
                <input
                  type="checkbox"
                  checked={hostSettings.allowUnmute}
                  onChange={(e) => onUpdateSettings({ allowUnmute: e.target.checked })}
                />
                <span className="switch-slider" />
              </label>
            </div>

            {/* 4. Turn on their video */}
            <div className="host-toggle-row">
              <div className="host-toggle-item-info">
                <div className="toggle-icon-wrap">
                  <Video size={18} color="#94A3B8" />
                </div>
                <div>
                  <span className="toggle-item-title">Turn on their video</span>
                  <span className="toggle-item-desc">
                    Allow participants to start their camera
                  </span>
                </div>
              </div>
              <label className="switch-toggle">
                <input
                  type="checkbox"
                  checked={hostSettings.allowCamera}
                  onChange={(e) => onUpdateSettings({ allowCamera: e.target.checked })}
                />
                <span className="switch-slider" />
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
