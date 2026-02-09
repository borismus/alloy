import React, { useEffect } from 'react';
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
      <button className="toast-dismiss" aria-label="Dismiss">×</button>
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
