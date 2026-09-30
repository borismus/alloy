import { describe, expect, it } from 'vitest';
import { attachmentMimeType, modelAcceptsAttachment } from './attachments';
import type { ModelInfo } from '../types';

const model = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({ key: 'p/m', name: 'M', ...overrides });

describe('attachmentMimeType', () => {
  it('keeps recognized MIME types', () => {
    expect(attachmentMimeType({ type: 'image/png', name: 'a.png' })).toBe('image/png');
    expect(attachmentMimeType({ type: 'application/pdf', name: 'a.pdf' })).toBe('application/pdf');
  });

  it('falls back to the extension when the MIME type is missing or generic', () => {
    expect(attachmentMimeType({ type: '', name: 'notes.MD' })).toBe('text/markdown');
    expect(attachmentMimeType({ type: 'application/octet-stream', name: 'paper.pdf' })).toBe('application/pdf');
    expect(attachmentMimeType({ type: '', name: 'photo.jpeg' })).toBe('image/jpeg');
  });

  it('rejects unsupported files', () => {
    expect(attachmentMimeType({ type: 'application/zip', name: 'a.zip' })).toBeNull();
    expect(attachmentMimeType({ type: 'text/plain', name: 'a.txt' })).toBeNull();
  });
});

describe('modelAcceptsAttachment', () => {
  it('treats images as supported unless explicitly not', () => {
    expect(modelAcceptsAttachment(model(), 'image/png')).toBe(true);
    expect(modelAcceptsAttachment(model({ supportsImages: false }), 'image/png')).toBe(false);
  });

  it('treats PDFs as unsupported unless explicitly supported', () => {
    expect(modelAcceptsAttachment(model(), 'application/pdf')).toBe(false);
    expect(modelAcceptsAttachment(model({ supportsPdfs: true }), 'application/pdf')).toBe(true);
  });

  it('always accepts Markdown', () => {
    expect(modelAcceptsAttachment(model({ supportsImages: false }), 'text/markdown')).toBe(true);
  });
});
