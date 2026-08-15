import { describe, expect, it } from 'vitest';
import { buildWatchWebSocketUrl } from './websocketUrl';

describe('buildWatchWebSocketUrl', () => {
  it('uses the page origin for same-origin web mode', () => {
    expect(buildWatchWebSocketUrl('', 'http://localhost:1420'))
      .toBe('ws://localhost:1420/api/watch');
  });

  it('uses an explicit HTTP API base', () => {
    expect(buildWatchWebSocketUrl('http://localhost:3030', 'http://localhost:1420'))
      .toBe('ws://localhost:3030/api/watch');
  });

  it('uses wss for HTTPS deployments', () => {
    expect(buildWatchWebSocketUrl('https://alloy.example', 'https://app.example'))
      .toBe('wss://alloy.example/api/watch');
  });

  it('does not duplicate a trailing slash', () => {
    expect(buildWatchWebSocketUrl('http://localhost:3030/', 'http://localhost:1420'))
      .toBe('ws://localhost:3030/api/watch');
  });

  it('returns null for a tauri:// origin with no API base', () => {
    // Regression: this produced 'tauri://localhost/api/watch', because the URL
    // spec ignores a .protocol assignment that would convert a non-special
    // scheme to a special one. WebKit then threw "SyntaxError: The string did
    // not match the expected pattern" — which masked the real failure (the
    // embedded server had no vault bound, so the API base was empty).
    expect(buildWatchWebSocketUrl('', 'tauri://localhost')).toBeNull();
  });

  it('still resolves under Tauri once the embedded server URL is known', () => {
    expect(buildWatchWebSocketUrl('http://127.0.0.1:51234', 'tauri://localhost'))
      .toBe('ws://127.0.0.1:51234/api/watch');
  });

  it('returns null rather than throwing on an unusable origin', () => {
    expect(buildWatchWebSocketUrl('', 'not a url')).toBeNull();
  });
});
