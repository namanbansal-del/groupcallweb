import React, { useEffect, useRef, useState } from 'react';
import { X, Send } from 'lucide-react';
import type { ChatMessage } from '../hooks/useWebGroupCall';

interface ChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  selfId: string;
  isChatDisabled?: boolean;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  isOpen,
  onClose,
  messages,
  onSend,
  selfId,
  isChatDisabled = false,
}) => {
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isOpen) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isOpen]);

  if (!isOpen) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isChatDisabled) return;
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  };

  return (
    <aside className="side-panel" aria-label="In-call messages">
      <div className="side-panel-head">
        <h2>In-call messages</h2>
        <button type="button" className="drawer-close-btn" onClick={onClose} aria-label="Close chat">
          <X size={18} />
        </button>
      </div>
      <p className="side-panel-note">Messages are only visible to people in the call and disappear when it ends.</p>
      <div className="chat-list">
        {messages.length === 0 && <div className="drawer-empty">No messages yet</div>}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.userId === selfId ? 'chat-msg-me' : ''}`}>
            <div className="chat-meta">
              <strong>{m.userId === selfId ? 'You' : m.name}</strong>
              <span>{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div className="chat-text">{m.text}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input
          className="form-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={isChatDisabled ? "Chat is disabled by the meeting host" : "Send a message"}
          maxLength={500}
          disabled={isChatDisabled}
        />
        <button type="submit" className="chat-send" aria-label="Send" disabled={isChatDisabled || !text.trim()}>
          <Send size={16} />
        </button>
      </form>
    </aside>
  );
};