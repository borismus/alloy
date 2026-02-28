/**
 * Mock implementation of @tauri-apps/plugin-http
 *
 * In server mode, proxies external HTTP requests through the Alloy server
 * to avoid CORS restrictions and localhost inaccessibility on mobile.
 */

const getApiBase = () => import.meta.env.VITE_API_URL || '';
const getAuthToken = () => import.meta.env.VITE_AUTH_TOKEN || '';

function serializeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => { result[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value;
    }
  } else {
    Object.assign(result, headers);
  }
  return result;
}

export const fetch: typeof globalThis.fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

  // Relative URLs go direct (our own server API)
  if (url.startsWith('/') || url.startsWith(window.location.origin)) {
    return window.fetch(input, init);
  }

  // External URLs: proxy through the server
  const proxyHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = getAuthToken();
  if (token) {
    proxyHeaders['Authorization'] = `Bearer ${token}`;
  }

  const body = init?.body != null ? String(init.body) : undefined;

  const proxyResponse = await window.fetch(`${getApiBase()}/api/proxy`, {
    method: 'POST',
    headers: proxyHeaders,
    body: JSON.stringify({
      url,
      method: init?.method || 'GET',
      headers: serializeHeaders(init?.headers),
      body,
    }),
    signal: init?.signal,
  });

  // Reconstruct original response headers from x-proxied-* prefix
  const originalHeaders = new Headers();
  proxyResponse.headers.forEach((value, key) => {
    if (key.startsWith('x-proxied-')) {
      originalHeaders.set(key.slice('x-proxied-'.length), value);
    }
  });

  return new Response(proxyResponse.body, {
    status: proxyResponse.status,
    statusText: proxyResponse.statusText,
    headers: originalHeaders,
  });
};

// Override global fetch for SDKs that don't accept a custom fetch (e.g. Gemini).
// Only intercepts known external API domains; everything else passes through.
const PROXIED_DOMAINS = [
  'generativelanguage.googleapis.com',
];

const originalFetch = window.fetch.bind(window);

window.fetch = ((
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

  try {
    const parsed = new URL(url, window.location.origin);
    if (PROXIED_DOMAINS.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
      return fetch(input, init);
    }
  } catch {
    // URL parse failed, pass through
  }

  return originalFetch(input, init);
}) as typeof window.fetch;
