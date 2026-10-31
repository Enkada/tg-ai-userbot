import { setTimeout as delay } from 'node:timers/promises';
import { fetch, type Dispatcher } from 'undici';

interface ResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type Request = (url: string, options: {
  method: 'POST' | 'PATCH';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  dispatcher?: Dispatcher;
}) => Promise<ResponseLike>;

interface SubmitOptions {
  endpointId: string;
  apiKey: string;
  input: unknown;
  signal?: AbortSignal;
  dispatcher?: Dispatcher;
  onResume?: () => void;
}

interface Submission {
  id?: string;
  status?: string;
}

function checkStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('Image request stopped'), { name: 'AbortError' });
}

/**
 * Resume a paused endpoint only when an image is requested. A rejected paused submission
 * has no job, so retrying it is safe. Network failures and other HTTP errors are never
 * retried: the server could already have accepted a billable job without returning its ID.
 */
export async function submitRunpodJob(
  options: SubmitOptions,
  request: Request = fetch,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> =
    (ms, signal) => delay(ms, undefined, { signal }),
): Promise<Submission> {
  const endpoint = encodeURIComponent(options.endpointId);
  const headers = { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ input: options.input });

  async function submit(timeoutMs = 15_000) {
    checkStopped(options.signal);
    const response = await request(`https://api.runpod.ai/v2/${endpoint}/run`, {
      method: 'POST', headers, body, dispatcher: options.dispatcher,
      // Keep receiving an accepted job's ID even if /stop arrives during submission;
      // the caller needs that ID to cancel it instead of leaving an orphan behind.
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let paused = false;
    if (response.status === 409) {
      try { paused = JSON.parse(text).code === 'ENDPOINT_PAUSED'; } catch { /* Not a paused response. */ }
    }
    return { response, text, paused };
  }

  const first = await submit();
  if (first.response.ok) return JSON.parse(first.text) as Submission;
  if (!first.paused) {
    throw new Error(`RunPod submit failed: HTTP ${first.response.status} ${first.text.slice(0, 200)}`);
  }

  checkStopped(options.signal);
  const timeout = AbortSignal.timeout(10_000);
  const resumed = await request(`https://api.runpod.io/v2/serverless/${endpoint}`, {
    method: 'PATCH', headers, body: JSON.stringify({ workers: { min: 0, max: 1 } }),
    dispatcher: options.dispatcher,
    signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
  });
  const resumeText = await resumed.text();
  if (!resumed.ok) {
    throw new Error(`RunPod reactivation failed: HTTP ${resumed.status} ${resumeText.slice(0, 200)}`);
  }
  options.onResume?.();

  // The management API can acknowledge the change before the job API sees it.
  // Only repeat explicit paused rejections, with one PATCH and a bounded wait.
  const deadline = Date.now() + 30_000;
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt++) {
    await wait(Math.min(2000, deadline - Date.now()), options.signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const retried = await submit(Math.min(15_000, remaining));
    if (retried.response.ok) return JSON.parse(retried.text) as Submission;
    if (!retried.paused) {
      throw new Error(`RunPod submit failed: HTTP ${retried.response.status} ${retried.text.slice(0, 200)}`);
    }
  }
  throw new Error('RunPod endpoint remained paused after reactivation');
}
