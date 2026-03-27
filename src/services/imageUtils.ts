const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // 4.5MB (headroom below Anthropic's 5MB limit)

export function mimeTypeFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return 'image/png';
  }
}

function base64ByteSize(base64: string): number {
  // Each base64 char encodes 6 bits, so 4 chars = 3 bytes
  // Adjust for padding
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function loadImage(base64: string, mimeType: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for compression'));
    img.src = `data:${mimeType};base64,${base64}`;
  });
}

function compressWithCanvas(
  img: HTMLImageElement,
  width: number,
  height: number,
  quality: number,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return dataUrl.split(',')[1];
}

export async function compressImageToFit(
  base64: string,
  mimeType: string,
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<{ data: string; mimeType: string }> {
  if (base64ByteSize(base64) <= maxBytes) {
    return { data: base64, mimeType };
  }

  const img = await loadImage(base64, mimeType);
  let { width, height } = img;
  let quality = 0.85;

  // Iteratively reduce dimensions and quality until under limit
  for (let attempt = 0; attempt < 5; attempt++) {
    const compressed = compressWithCanvas(img, width, height, quality);
    if (base64ByteSize(compressed) <= maxBytes) {
      return { data: compressed, mimeType: 'image/jpeg' };
    }
    // Reduce dimensions by 25% and quality slightly each iteration
    width = Math.floor(width * 0.75);
    height = Math.floor(height * 0.75);
    quality = Math.max(0.5, quality - 0.1);
  }

  // Final fallback: aggressive compression
  const fallback = compressWithCanvas(img, Math.floor(img.width * 0.25), Math.floor(img.height * 0.25), 0.5);
  return { data: fallback, mimeType: 'image/jpeg' };
}
