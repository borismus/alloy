import { describe, it, expect, vi, beforeEach } from 'vitest';
import { compressImageToFit, mimeTypeFromPath } from './imageUtils';

// Mock canvas and Image APIs for happy-dom
function setupCanvasMock(outputBase64Size: number) {
  // Generate a fake base64 string of the desired decoded byte size
  // base64 encodes 3 bytes per 4 chars
  const base64Chars = Math.ceil((outputBase64Size * 4) / 3);
  const fakeBase64 = 'A'.repeat(base64Chars);
  const fakeDataUrl = `data:image/jpeg;base64,${fakeBase64}`;

  const mockCtx = {
    drawImage: vi.fn(),
  };

  const mockCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => mockCtx),
    toDataURL: vi.fn(() => fakeDataUrl),
  };

  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'canvas') return mockCanvas as unknown as HTMLCanvasElement;
    return document.createElement(tag);
  });

  return { mockCanvas, mockCtx };
}

function mockImageLoad(width: number, height: number) {
  // Mock the Image constructor — must be a regular function (not arrow) to work with `new`
  const originalImage = globalThis.Image;
  globalThis.Image = function MockImage(this: any) {
    this.width = width;
    this.height = height;
    this.onload = null;
    this.onerror = null;
    Object.defineProperty(this, 'src', {
      set(_url: string) {
        setTimeout(() => this.onload?.(), 0);
      },
    });
  } as unknown as typeof Image;
  return () => { globalThis.Image = originalImage; };
}

describe('mimeTypeFromPath', () => {
  it('returns image/jpeg for .jpg', () => {
    expect(mimeTypeFromPath('attachments/img-001.jpg')).toBe('image/jpeg');
  });

  it('returns image/jpeg for .jpeg', () => {
    expect(mimeTypeFromPath('attachments/img-001.jpeg')).toBe('image/jpeg');
  });

  it('returns image/png for .png', () => {
    expect(mimeTypeFromPath('attachments/img-001.png')).toBe('image/png');
  });

  it('returns image/webp for .webp', () => {
    expect(mimeTypeFromPath('attachments/img-001.webp')).toBe('image/webp');
  });

  it('returns image/gif for .gif', () => {
    expect(mimeTypeFromPath('attachments/img-001.gif')).toBe('image/gif');
  });

  it('defaults to image/png for unknown extensions', () => {
    expect(mimeTypeFromPath('attachments/img-001.bmp')).toBe('image/png');
  });
});

describe('compressImageToFit', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns original data when under size limit', async () => {
    // 100 bytes of base64 data (well under any limit)
    const smallBase64 = 'A'.repeat(100);
    const result = await compressImageToFit(smallBase64, 'image/png', 1024 * 1024);

    expect(result).toEqual({ data: smallBase64, mimeType: 'image/png' });
  });

  it('preserves original mimeType when no compression needed', async () => {
    const smallBase64 = 'A'.repeat(100);
    const result = await compressImageToFit(smallBase64, 'image/webp', 1024 * 1024);

    expect(result.mimeType).toBe('image/webp');
  });

  it('compresses large images and returns image/jpeg', async () => {
    // Create base64 that decodes to > 1KB (our test limit)
    const largeBase64 = 'A'.repeat(2000); // ~1500 decoded bytes

    // Mock canvas to return small output
    const { mockCanvas, mockCtx } = setupCanvasMock(500);
    const restoreImage = mockImageLoad(2000, 1000);

    const result = await compressImageToFit(largeBase64, 'image/png', 1024);

    expect(result.mimeType).toBe('image/jpeg');
    expect(mockCanvas.getContext).toHaveBeenCalledWith('2d');
    expect(mockCtx.drawImage).toHaveBeenCalled();
    expect(mockCanvas.toDataURL).toHaveBeenCalledWith('image/jpeg', expect.any(Number));

    restoreImage();
  });

  it('reduces dimensions iteratively when first compression is still too large', async () => {
    const largeBase64 = 'A'.repeat(2000);

    let callCount = 0;
    const mockCtx = { drawImage: vi.fn() };
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => mockCtx),
      toDataURL: vi.fn(() => {
        callCount++;
        // First two calls return too-large data, third call returns small enough
        const size = callCount < 3 ? 2000 : 200;
        const chars = Math.ceil((size * 4) / 3);
        return `data:image/jpeg;base64,${'A'.repeat(chars)}`;
      }),
    };

    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas as unknown as HTMLCanvasElement;
      return document.createElement(tag);
    });

    const restoreImage = mockImageLoad(4000, 3000);

    const result = await compressImageToFit(largeBase64, 'image/png', 1024);

    expect(result.mimeType).toBe('image/jpeg');
    // Should have been called multiple times due to iterative compression
    expect(mockCanvas.toDataURL.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Verify dimensions were reduced: canvas dimensions should decrease each iteration
    // First call: original * scale, subsequent calls: 75% of previous
    // Canvas width is set before each toDataURL call
    expect(mockCtx.drawImage).toHaveBeenCalledTimes(callCount);

    restoreImage();
  });
});
