import React, { useEffect } from 'react';
import { IconButton } from './ui';
import './Toast.css';

export interface ToastMessage {
  id: string;
  message: string;
  type?: 'info' | 'warning' | 'error';
}

interface ToastProps {
  message: ToastMessage;
  onDismiss: (id: string) => void;
  duration?: number;
}

export const Toast: React.FC<ToastProps> = ({ message, onDismiss, duration = 2000 }) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(message.id);
    }, duration);
    return () => clearTimeout(timer);
  }, [message.id, onDismiss, duration]);

  return (
    <div className={`toast toast-${message.type || 'info'}`} onClick={() => onDismiss(message.id)}>
      <span className="toast-message">{message.message}</span>
      <span className="toast-dismiss">
        <IconButton label="Dismiss" size="compactIcon" onPress={() => onDismiss(message.id)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </IconButton>
      </span>
    </div>
  );
};

interface ToastContainerProps {
  messages: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ messages, onDismiss }) => {
  if (messages.length === 0) return null;

  return (
    <div className="toast-container">
      {messages.map(msg => (
        <Toast key={msg.id} message={msg} onDismiss={onDismiss} />
      ))}
    </div>
  );
};
