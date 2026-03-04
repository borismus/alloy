/** Generate a short unique message ID for provenance tracking */
export const generateMessageId = () => `msg-${Math.random().toString(16).slice(2, 6)}`;
