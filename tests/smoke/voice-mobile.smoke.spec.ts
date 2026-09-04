import { expect, test, type Page } from '@playwright/test';

const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

interface MockVoiceSession {
  configs: Array<{ enable_endpoint_detection?: boolean }>;
  stopSignals: string[];
  finish: () => void;
}

async function installMockMicrophone(page: Page, transcript: string, automaticEndpoint: boolean): Promise<MockVoiceSession> {
  await page.addInitScript(() => {
    const fakeStream = {
      getTracks: () => [{ stop: () => {} }],
    } as unknown as MediaStream;

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => fakeStream },
    });

    class FakeMediaRecorder extends EventTarget {
      stream: MediaStream;
      state = 'inactive';

      constructor(stream: MediaStream) {
        super();
        this.stream = stream;
      }

      start() {
        this.state = 'recording';
      }

      stop() {
        this.state = 'inactive';
        this.dispatchEvent(new Event('stop'));
      }
    }

    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder,
    });
  });

  const configs: MockVoiceSession['configs'] = [];
  const stopSignals: string[] = [];
  let finish: (() => void) | null = null;
  await page.routeWebSocket(SONIOX_URL, ws => {
    let configured = false;
    finish = () => ws.send(JSON.stringify({
      tokens: [],
      final_audio_proc_ms: 500,
      total_audio_proc_ms: 500,
      finished: true,
    }));

    ws.onMessage(message => {
      if (typeof message !== 'string') return;

      if (!configured) {
        configured = true;
        const config = JSON.parse(message) as { enable_endpoint_detection?: boolean };
        configs.push(config);
        setTimeout(() => {
          ws.send(JSON.stringify({
            tokens: [{
              text: transcript,
              start_ms: 0,
              end_ms: 500,
              confidence: 1,
              is_final: automaticEndpoint,
            }, ...(automaticEndpoint ? [{
              text: '<end>',
              start_ms: 500,
              end_ms: 500,
              confidence: 1,
              is_final: true,
            }] : [])],
            final_audio_proc_ms: 500,
            total_audio_proc_ms: 500,
          }));
        }, 10);
        return;
      }

      // SonioxClient sends an empty frame from stop(). Record it separately so
      // the test proves pointer release stopped recording before the mock
      // server delivers its final result.
      if (message === '') stopSignals.push(message);
    });
  });

  return {
    configs,
    stopSignals,
    finish: () => finish?.(),
  };
}

async function openConversation(page: Page) {
  await page.goto('/');
  await expect(page.locator('.timeline-item').first()).toBeVisible();
  await page.getByText('Welcome to Alloy').click();

  const mic = page.getByRole('button', { name: 'Start voice input' });
  const textarea = page.locator('.input-row textarea');
  await expect(mic).toBeVisible();
  await expect(textarea).toBeVisible();

  const [micBox, textareaBox, viewportWidth] = await Promise.all([
    mic.boundingBox(),
    textarea.boundingBox(),
    page.evaluate(() => window.innerWidth),
  ]);
  expect(micBox?.width).toBeGreaterThanOrEqual(44);
  expect(micBox?.height).toBeGreaterThanOrEqual(44);
  expect(textareaBox!.y).toBeLessThan(micBox!.y);
  expect(micBox!.x + micBox!.width).toBeLessThanOrEqual(viewportWidth);
}

async function rejectModelRequest(page: Page) {
  await page.route('**/api/stream/start', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'intentional voice smoke response' }),
  }));
}

test('mobile voice: tap uses automatic endpoint detection and sends once', async ({ page }) => {
  const transcript = 'Automatic mobile voice turn';
  const session = await installMockMicrophone(page, transcript, true);
  await rejectModelRequest(page);
  await openConversation(page);

  const startRequest = page.waitForRequest(request => request.url().endsWith('/api/stream/start'));
  await page.getByRole('button', { name: 'Start voice input' }).click();
  const request = await startRequest;

  expect(session.configs).toHaveLength(1);
  expect(session.configs[0].enable_endpoint_detection).toBe(true);
  expect(request.postDataJSON().userMessageContent).toBe(transcript);
  await expect.poll(() => session.stopSignals.length).toBe(1);
  session.finish();
  await expect(page.locator('.input-row textarea')).toHaveValue(transcript);
});

test('mobile voice: holding disables automatic endpoints and release sends', async ({ page }) => {
  const transcript = 'Explicit mobile voice turn';
  const session = await installMockMicrophone(page, transcript, false);
  await rejectModelRequest(page);
  await openConversation(page);

  const mic = page.getByRole('button', { name: 'Start voice input' });
  const box = await mic.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();

  await expect.poll(() => session.configs.length).toBe(1);
  expect(session.configs[0].enable_endpoint_detection).toBe(false);
  await expect(page.locator('.input-row textarea')).toHaveValue(transcript);

  await page.mouse.up();
  await expect.poll(() => session.stopSignals.length).toBe(1);

  const startRequest = page.waitForRequest(request => request.url().endsWith('/api/stream/start'));
  session.finish();
  const request = await startRequest;

  expect(request.postDataJSON().userMessageContent).toBe(transcript);
  await expect(page.locator('.input-row textarea')).toHaveValue(transcript);
});
