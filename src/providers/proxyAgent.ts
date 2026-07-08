/**
 * Optional HTTP proxy for OpenRouter's calls, reusing the same `PROXY_URL` set for the
 * Telegram connection. Some hosts are reachable directly but blocked by OpenRouter's edge
 * (HTTP 403 on every request); when that's the case, routing through the proxy restores access.
 *
 * Only `http(s)://` proxy URLs apply: undici's `ProxyAgent` can't tunnel SOCKS5 or MTProxy
 * `t.me` links, so those yield `undefined` and OpenRouter calls go direct. Unset ⇒ direct.
 */
import { ProxyAgent, type Dispatcher } from 'undici';
import { config } from '../config.js';

let cached: Dispatcher | undefined | null = null;

/** Lazily builds (and caches) the proxy dispatcher, or `undefined` for a direct connection. */
export function getOpenRouterDispatcher(): Dispatcher | undefined {
  if (cached === null) {
    const url = config.proxyUrl;
    cached = url && /^https?:\/\//i.test(url) ? new ProxyAgent(url) : undefined;
  }
  return cached;
}
