export const STREAM_STALL_TIMEOUT_MS = 30_000;

export class StreamStalledError extends Error {
  constructor(timeoutMs: number) {
    super(`Stream stalled: no data received for ${timeoutMs}ms`);
    this.name = 'StreamStalledError';
  }
}

/**
 * Wraps an async iterable so each `next()` is raced against a timeout.
 * If no chunk arrives within `timeoutMs`, throws StreamStalledError.
 *
 * Mobile WKWebView/Chrome can suspend in-flight fetches when the app
 * backgrounds; when JS resumes, the connection may be silently dead and
 * `reader.read()` awaits forever. This watchdog surfaces that as an error
 * so the UI can clean up instead of staying stuck on "streaming".
 */
export async function* withStreamTimeout<T>(
  iterable: AsyncIterable<T>,
  options: { timeoutMs?: number; abort?: { abort: () => void } } = {},
): AsyncIterable<T> {
  const timeoutMs = options.timeoutMs ?? STREAM_STALL_TIMEOUT_MS;
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            options.abort?.abort();
            reject(new StreamStalledError(timeoutMs));
          }, timeoutMs);
        }),
      ]);
      if (result.done) return;
      yield result.value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Race a single `reader.read()` against a timeout. Used for raw
 * ReadableStreamDefaultReader loops (e.g. Ollama).
 */
export function readWithTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs: number = STREAM_STALL_TIMEOUT_MS,
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    reader.read().finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reader.cancel().catch(() => {});
        reject(new StreamStalledError(timeoutMs));
      }, timeoutMs);
    }),
  ]);
}
