import React, { useState, useRef, useEffect } from 'react';
import { X, Check, Sparkles, Upload, Eye } from 'lucide-react';
import type { BackgroundMode } from '../utils/virtualBackground';
import techugoImgUrl from '../assets/techugoImg.jpg';

interface VirtualBackgroundModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentMode: BackgroundMode;
  onSelectMode: (mode: BackgroundMode, customImageUrl?: string) => void;
  localStream: MediaStream | null;
}

export const VirtualBackgroundModal: React.FC<VirtualBackgroundModalProps> = ({
  isOpen,
  onClose,
  currentMode,
  onSelectMode,
  localStream,
}) => {
  const [selectedMode, setSelectedMode] = useState<BackgroundMode>(currentMode);
  const [customImage, setCustomImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    setSelectedMode(currentMode);
  }, [currentMode, isOpen]);

  // Hook up preview video
  useEffect(() => {
    if (isOpen && previewVideoRef.current && localStream) {
      const el = previewVideoRef.current;
      if (el.srcObject !== localStream) {
        el.srcObject = localStream;
      }
      el.onloadedmetadata = () => {
        el.play().catch(() => {});
      };
      el.play().catch(() => {});
    }
  }, [isOpen, localStream]);

  if (!isOpen) return null;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        setCustomImage(result);
        setSelectedMode('image-custom');
        onSelectMode('image-custom', result);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSelect = (mode: BackgroundMode) => {
    setSelectedMode(mode);
    if (mode === 'image-custom' && customImage) {
      onSelectMode(mode, customImage);
    } else {
      onSelectMode(mode);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="virtual-bg-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Virtual Background & Visual Effects"
      >
        <div className="modal-header">
          <div className="modal-title-wrap">
            <Sparkles size={20} className="icon-sparkle" />
            <h3>Visual Effects & Background</h3>
          </div>
          <button type="button" className="btn-modal-close" onClick={onClose} aria-label="Close modal">
            <X size={20} />
          </button>
        </div>

        {/* Live Preview Box */}
        <div className="vb-preview-area">
          <video
            ref={previewVideoRef}
            autoPlay
            playsInline
            muted
            className="vb-preview-video video-mirrored"
          />
          <div className="vb-preview-badge">
            <Eye size={13} />
            <span>Live Camera Feed</span>
          </div>
        </div>

        {/* Options List */}
        <div className="vb-options-container">
          <span className="vb-section-label">Select Background:</span>

          <div className="vb-cards-grid">
            {/* 1. None */}
            <button
              type="button"
              className={`vb-card ${selectedMode === 'none' ? 'vb-card-active' : ''}`}
              onClick={() => handleSelect('none')}
            >
              <div className="vb-thumb vb-thumb-none">
                <span className="vb-thumb-text">None</span>
              </div>
              <span className="vb-card-label">Original Camera</span>
              {selectedMode === 'none' && <Check size={16} className="vb-card-check" />}
            </button>

            {/* 2. Light Blur */}
            <button
              type="button"
              className={`vb-card ${selectedMode === 'blur-light' ? 'vb-card-active' : ''}`}
              onClick={() => handleSelect('blur-light')}
            >
              <div className="vb-thumb vb-thumb-blur-light">
                <div className="blur-effect-indicator blur-light-box" />
              </div>
              <span className="vb-card-label">Slight Blur</span>
              {selectedMode === 'blur-light' && <Check size={16} className="vb-card-check" />}
            </button>

            {/* 3. Heavy Blur */}
            <button
              type="button"
              className={`vb-card ${selectedMode === 'blur-heavy' ? 'vb-card-active' : ''}`}
              onClick={() => handleSelect('blur-heavy')}
            >
              <div className="vb-thumb vb-thumb-blur-heavy">
                <div className="blur-effect-indicator blur-heavy-box" />
              </div>
              <span className="vb-card-label">Heavy Blur</span>
              {selectedMode === 'blur-heavy' && <Check size={16} className="vb-card-check" />}
            </button>

            {/* 4. Techugo Office Background */}
            <button
              type="button"
              className={`vb-card ${selectedMode === 'image-techugo' ? 'vb-card-active' : ''}`}
              onClick={() => handleSelect('image-techugo')}
            >
              <div
                className="vb-thumb vb-thumb-image"
                style={{ backgroundImage: `url(${techugoImgUrl || '/assets/techugoImg.jpg'})` }}
              />
              <span className="vb-card-label">Techugo Office</span>
              {selectedMode === 'image-techugo' && <Check size={16} className="vb-card-check" />}
            </button>

            {/* 5. Custom Upload */}
            <button
              type="button"
              className={`vb-card ${selectedMode === 'image-custom' ? 'vb-card-active' : ''}`}
              onClick={() => {
                if (customImage) {
                  handleSelect('image-custom');
                } else {
                  fileInputRef.current?.click();
                }
              }}
            >
              <div
                className="vb-thumb vb-thumb-custom"
                style={customImage ? { backgroundImage: `url(${customImage})` } : {}}
              >
                {!customImage ? (
                  <Upload size={22} color="#94A3B8" />
                ) : (
                  <span className="vb-thumb-text">Custom</span>
                )}
              </div>
              <span className="vb-card-label">
                {customImage ? 'Custom Image' : 'Upload Image'}
              </span>
              {selectedMode === 'image-custom' && <Check size={16} className="vb-card-check" />}
            </button>
          </div>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept="image/*"
            style={{ display: 'none' }}
          />
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-modal-cancel" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
