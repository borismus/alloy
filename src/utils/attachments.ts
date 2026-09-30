import type { ModelInfo, PendingAttachment } from '../types';

export const PDF_MIME = 'application/pdf';
export const MARKDOWN_MIME = 'text/markdown';

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

// Fallback when the browser/OS reports an empty or generic MIME type (common
// for .md, and for drag-and-drop from some apps).
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: PDF_MIME,
  md: MARKDOWN_MIME,
  markdown: MARKDOWN_MIME,
};

/** `accept` attribute for the composer's file picker. */
export const ATTACHMENT_ACCEPT = [
  ...IMAGE_MIMES,
  PDF_MIME,
  MARKDOWN_MIME,
  ...Object.keys(MIME_BY_EXTENSION).map(ext => `.${ext}`),
].join(',');

/** Normalized MIME type for a supported attachment, or null if unsupported. */
export function attachmentMimeType(file: { type: string; name: string }): string | null {
  if (IMAGE_MIMES.includes(file.type) || file.type === PDF_MIME || file.type === MARKDOWN_MIME) {
    return file.type;
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? null;
}

export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/**
 * Can this model take an attachment of this type? Images are supported unless
 * the backend says otherwise; PDFs only where the model reads them natively
 * (Alloy never extracts PDF text); Markdown is inlined as text, so always.
 */
export function modelAcceptsAttachment(model: ModelInfo | undefined, mimeType: string): boolean {
  if (isImageMime(mimeType)) return model?.supportsImages !== false;
  if (mimeType === PDF_MIME) return model?.supportsPdfs === true;
  return true;
}

/** Read picked, pasted, or dropped files into pending attachments, skipping unsupported types. */
export async function toPendingAttachments(files: File[]): Promise<PendingAttachment[]> {
  const out: PendingAttachment[] = [];
  for (const file of files) {
    const mimeType = attachmentMimeType(file);
    if (!mimeType) continue;
    const data = new Uint8Array(await file.arrayBuffer());
    const preview = isImageMime(mimeType) ? URL.createObjectURL(file) : undefined;
    out.push({ data, mimeType, name: file.name, preview });
  }
  return out;
}
