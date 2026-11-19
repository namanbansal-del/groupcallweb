import React from 'react';

export const REACTION_EMOJIS = ['👍', '👏', '❤️', '😂', '😮', '🎉'];

export const ReactionPicker: React.FC<{ onPick: (emoji: string) => void }> = ({ onPick }) => (
  <div className="reaction-picker" role="menu">
    {REACTION_EMOJIS.map((e) => (
      <button key={e} type="button" className="reaction-btn" onClick={() => onPick(e)} aria-label={`React ${e}`}>
        {e}
      </button>
    ))}
  </div>
);

export const ReactionsOverlay: React.FC<{ reactions: { id: string; emoji: string; name: string }[] }> = ({
  reactions,
}) => (
  <div className="reactions-layer" aria-hidden="true">
    {reactions.map((r, i) => (
      <div key={r.id} className="reaction-float" style={{ left: `${10 + ((i * 17) % 60)}%` }}>
        <span className="reaction-emoji">{r.emoji}</span>
        <span className="reaction-name">{r.name}</span>
      </div>
    ))}
  </div>
);