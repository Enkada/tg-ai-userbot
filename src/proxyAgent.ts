/**
 * Optional HTTP proxy for the bot's outbound API calls, reusing the same `PROXY_URL` set
 * for the Telegram connection. Some hosts are reachable directly but blocked by an API's
 * edge (HTTP 403 on every request, returned by the load balancer before the request ever
 * reaches the API); when that's the case, routing through the proxy restores access. Both
 * OpenRouter and Tavily have blocked the prod VDS this way — Tavily's rule keys on the
 * source IP *and* the presence of a `tvly-` key, so an unauthenticated request still gets
 * through while every real one 403s.
 *
 * Only `http(s)://` proxy URLs apply: undici's `ProxyAgent` can't tunnel SOCKS5 or MTProxy
 * `t.me` links, so those yield `undefined` and the calls go direct. Unset ⇒ direct.
 */
import { ProxyAgent, type Dispatcher } from 'undici';
import { config } from './config.js';

let cached: Dispatcher | undefined | null = null;

/** Lazily builds (and caches) the proxy dispatcher, or `undefined` for a direct connection. */
export function getProxyDispatcher(): Dispatcher | undefined {
  if (cached === null) {
    const url = config.proxyUrl;
    cached = url && /^https?:\/\//i.test(url) ? new ProxyAgent(url) : undefined;
  }
  return cached;
}
