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
});
