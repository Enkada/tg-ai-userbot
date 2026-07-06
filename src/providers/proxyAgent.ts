/**
 * Reuses the Telegram MTProto proxy (`PROXY_URL`) for OpenRouter's HTTPS calls. The same
 * hosting-provider IP that gets Telegram's data centres blocked also trips OpenRouter's WAF
 * ("Access denied by security policy", HTTP 403 on every request, even unauthenticated ones);
 * routing through the proxy fixes both. Only `http(s)://` proxy URLs work here — undici's
 * `ProxyAgent` doesn't tunnel SOCKS5 or MTProxy `t.me` links, so those are left alone and
 * OpenRouter calls go direct (unblocked hosts don't need the detour anyway).
 */
import { ProxyAgent, type Dispatcher } from 'undici';
import { config } from '../config.js';

let cached: Dispatcher | undefined | null = null;

export function getOpenRouterDispatcher(): Dispatcher | undefined {
  if (cached === null) {
    const url = config.proxyUrl;
    cached = url && /^https?:\/\//i.test(url) ? new ProxyAgent(url) : undefined;
  }
  return cached;
}
