import { describe, expect, it } from 'vitest';
import { attachmentMimeType, formatMegabytes, modelAcceptsAttachment, pdfTooLarge } from './attachments';
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

describe('pdfTooLarge', () => {
  const pdf = (size: number) => ({ data: new Uint8Array(size), mimeType: 'application/pdf', name: 'a.pdf' });
  it('only applies when the model has a known limit', () => {
    expect(pdfTooLarge(model({ supportsPdfs: true }), pdf(10))).toBe(false);
    expect(pdfTooLarge(model({ supportsPdfs: true, maxPdfBytes: 5 }), pdf(10))).toBe(true);
    expect(pdfTooLarge(model({ supportsPdfs: true, maxPdfBytes: 10 }), pdf(10))).toBe(false);
  });

  it('ignores non-PDFs', () => {
    expect(pdfTooLarge(model({ maxPdfBytes: 5 }), { ...pdf(10), mimeType: 'image/png' })).toBe(false);
  });
});

describe('formatMegabytes', () => {
  it('formats with one decimal, dropping a trailing .0', () => {
    expect(formatMegabytes(19_593_751)).toBe('19.6 MB');
    expect(formatMegabytes(15_000_000)).toBe('15 MB');
  });
});
