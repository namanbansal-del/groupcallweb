import React, { useState } from 'react';
import { X, User, Phone, Lock, LogIn, UserPlus, AlertCircle, CheckCircle } from 'lucide-react';

export interface AuthUser {
  id: string;
  name: string;
  phone: string;
}

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverUrl: string;
  onAuthSuccess: (user: AuthUser, token: string) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  serverUrl,
  onAuthSuccess,
}) => {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);

    const endpoint = mode === 'signup' ? '/api/calling/signup' : '/api/calling/login';
    const body =
      mode === 'signup'
        ? { name: name.trim(), phone: phone.trim(), password }
        : { phone: phone.trim(), password };

    try {
      const res = await fetch(`${serverUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Authentication request failed');
      }

      setSuccess(mode === 'signup' ? 'Account created successfully!' : 'Signed in successfully!');
      localStorage.setItem('calling_authToken', data.token);
      localStorage.setItem('calling_currentUser', JSON.stringify(data.user));

      setTimeout(() => {
        onAuthSuccess(data.user, data.token);
        onClose();
      }, 500);
    } catch (err: any) {
      setError(err.message || 'Unable to connect to authentication server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-modal-backdrop" onClick={onClose}>
      <div className="auth-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="auth-modal-header">
          <div className="auth-modal-title-wrap">
            <h2 className="auth-modal-title">
              {mode === 'login' ? 'Sign In' : 'Create Account'}
            </h2>
            <p className="auth-modal-subtitle">
              {mode === 'login'
                ? 'Sign in to access host controls and saved meeting identity'
                : 'Register your account for seamless Google Meet group calls'}
            </p>
          </div>
          <button type="button" className="auth-modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Mode Switcher Tabs */}
        <div className="auth-modal-tabs">
          <button
            type="button"
            className={`auth-modal-tab ${mode === 'login' ? 'tab-active' : ''}`}
            onClick={() => {
              setMode('login');
              setError(null);
            }}
          >
            <LogIn size={15} />
            <span>Sign In</span>
          </button>
          <button
            type="button"
            className={`auth-modal-tab ${mode === 'signup' ? 'tab-active' : ''}`}
            onClick={() => {
              setMode('signup');
              setError(null);
            }}
          >
            <UserPlus size={15} />
            <span>Sign Up</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="auth-modal-form">
          {mode === 'signup' && (
            <div className="auth-field-group">
              <label htmlFor="authName">Full Name</label>
              <div className="auth-field-input-wrap">
                <User size={16} className="auth-field-icon" />
                <input
                  id="authName"
                  type="text"
                  placeholder="e.g. Alex Johnson"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required={mode === 'signup'}
                />
              </div>
            </div>
          )}

          <div className="auth-field-group">
            <label htmlFor="authPhone">Phone Number / Account ID</label>
            <div className="auth-field-input-wrap">
              <Phone size={16} className="auth-field-icon" />
              <input
                id="authPhone"
                type="text"
                placeholder="+1234567890"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="auth-field-group">
            <label htmlFor="authPassword">Password</label>
            <div className="auth-field-input-wrap">
              <Lock size={16} className="auth-field-icon" />
              <input
                id="authPassword"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>

          {error && (
            <div className="auth-feedback-alert feedback-error">
              <AlertCircle size={15} />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="auth-feedback-alert feedback-success">
              <CheckCircle size={15} />
              <span>{success}</span>
            </div>
          )}

          <button type="submit" className="auth-modal-submit" disabled={loading}>
            <span>
              {loading
                ? 'Connecting...'
                : mode === 'signup'
                ? 'Create Account'
                : 'Sign In to Account'}
            </span>
          </button>
        </form>
      </div>
    </div>
  );
};
