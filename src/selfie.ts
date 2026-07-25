/**
 * Selfies: the `send_selfie` tool — RunPod serverless ComfyUI image generation.
 *
 * The pipeline, per picture: the chat model calls the tool with a plain-prose description
 * ("selfie of me on my bed, default clothes, smirk, night") → the *booru pass* (a cheap
 * dedicated model, see prompts/passes/booru.txt) converts prose to a Danbooru tag prompt opened
 * by the character's identity tags (prompts/passes/booru-appearance.txt) → a ComfyUI workflow is built
 * in code (base 720×1280 pass, optional 2× latent upscale second pass — the `/img upscale`
 * toggle) → submitted to the RunPod serverless endpoint and polled to completion → the PNG
 * is sent as a Telegram photo with a caption line generated *in parallel* with the image.
 *
 * Prompt-design findings baked in here (tested 2026-07-18, see memory/image-gen-runpod):
 * - "You generate pictures of yourself, there's no camera" framing resolves the bodiless-AI
 *   persona conflict; the model handles meta probes gracefully.
 * - The model sometimes *promises* a picture without emitting the call (~50% on implicit
 *   asks at temp 1). Prompt rules don't close it — the {@link maybeRepairPromise} gate does:
 *   a cheap regex pre-filter, then an LLM call that rereads the reply and outputs either the
 *   tool call or "no". Only a well-formed parsed call opens the image path; every other
 *   outcome (a "no", rambling, a typo'd tag) is a no-op, so the gate's failure mode is
 *   always "do nothing", never "send an unwanted image".
 * - Every LLM call here must run with reasoning off (the booru pass inherits this from
 *   {@link booruPass}); Baidu's default-on reasoning eats the token budget → null content.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InputMedia, type InputPeerLike, type TelegramClient } from '@mtcute/node';
import { fetch } from 'undici';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { activeProviderId, chat } from './llm.js';
import { booruPass } from './providers/openrouter.js';
import { getWindow, saveAttachment, saveMessage, savePhotoGen } from './memory.js';
import {
  BOORU_APPEARANCE,
  BOORU_PASS,
  SELFIE_ACK_FALLBACK,
  SELFIE_FAILURE_CUE,
  SELFIE_FAILURE_FALLBACK,
  selfieAckCue,
  selfieCaptionCue,
} from './prompts/index.js';
import { dropPanel, showPanel } from './panel.js';
import { getImgUpscale } from './settings.js';
import { renderMarkdown } from './format.js';
import { sanitize } from './sanitize.js';
import { splitMessage } from './chunker.js';
import { parseToolCall, stripToolCalls } from './tools.js';

const log = createLogger('selfie');

const cfg = config.selfie;

/** Whether the feature exists at all: RunPod credentials + OpenRouter (for the booru pass). */
export function isSelfieConfigured(): boolean {
  return Boolean(cfg.runpodApiKey && cfg.endpointId && config.llm.openrouter.apiKey);
}

/**
 * Whether the tool may be offered right now. Same as configured — the daily cap was removed
 * (2026-07-24): each image costs ~$0.005 and every generation takes a full model turn inside
 * the chat's serial queue, so there's no runaway loop for a cap to stop. The seam is kept so
 * a runtime gate can return here without touching the call sites.
 */
export function isSelfieAvailable(): boolean {
  return isSelfieConfigured();
}

// ---- Appearance file (identity tags, outfit blocks, quality tags, negative) --------------

interface Appearance {
  /** The identity tag block that opens every prompt, flattened to one line. */
  identity: string;
  /** Named outfit blocks (`## Outfit: <name>` sections), keyed by lowercase name. */
  outfits: Map<string, string>;
  /** Quality/trigger tags appended to every positive prompt in code (never by the LLM). */
  quality: string;
  /** The static negative prompt. */
  negative: string;
}

let appearanceCache: Appearance | undefined;

/** One `## <name>` section's body from the appearance file, flattened to a single tag line. */
function flatten(block: string): string {
  return block.trim().replace(/\s*\n\s*/g, ' ').replace(/,\s*$/, '');
}

/**
 * Parses {@link BOORU_APPEARANCE} into its identity/outfit/quality/negative sections. The text
 * is loaded at startup with the other prompt files; only this parse is lazy, so a malformed
 * appearance file fails the first selfie rather than the whole boot.
 */
function loadAppearance(): Appearance {
  if (appearanceCache) return appearanceCache;
  const raw = BOORU_APPEARANCE;
  const identity = flatten(/# Identity\n([\s\S]*?)(?=\n## )/.exec(raw)?.[1] ?? '');
  if (!identity) throw new Error(`No "# Identity" block in ${cfg.appearancePath}`);
  const outfits = new Map<string, string>();
  for (const m of raw.matchAll(/## Outfit:\s*(.+)\n([\s\S]*?)(?=\n## |$)/g)) {
    outfits.set(m[1].trim().toLowerCase(), flatten(m[2]));
  }
  const section = (name: string) =>
    flatten(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(raw)?.[1] ?? '');
  appearanceCache = { identity, outfits, quality: section('Quality'), negative: section('Negative') };
  return appearanceCache;
}

// ---- Booru pass (prose → tag prompt) -----------------------------------------------------

/**
 * Converts the model's prose description into the full positive tag prompt (identity tags
 * first, quality tags appended). Throws when the pass returns something that can't be a tag
 * line for this character — the flow treats that as a failed generation.
 */
export async function proseToTags(prose: string, signal?: AbortSignal): Promise<string> {
  const app = loadAppearance();
  const system = BOORU_PASS
    .replace(/\{\{\s*identity\s*\}\}/g, app.identity)
    .replace(/\{\{\s*outfit_(\w+)\s*\}\}/g, (m, name: string) => app.outfits.get(name.toLowerCase()) ?? m);
  const out = (await booruPass(system, prose, signal)).trim().replace(/\s*\n+\s*/g, ' ');
  // Shape guard: the identity block must have been copied (its first tag is the anchor).
  const anchor = app.identity.split(',')[0].trim();
  if (!out || !out.toLowerCase().includes(anchor)) {
    throw new Error(`Booru pass returned an unusable prompt: "${out.slice(0, 120)}"`);
  }
  return `${out},\n${app.quality}`;
}

// ---- ComfyUI workflow (API format), built in code ----------------------------------------

/** A ComfyUI API-format prompt graph: node id → { class_type, inputs }. */
type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

const randomSeed = (): number => Math.floor(Math.random() * 2 ** 48);

/**
 * The generation graph: checkpoint + clip-skip 2 + LoRA, one 30-step euler/CFG5 base pass at
 * {@link config.selfie.width}×{@link config.selfie.height}, and — when `upscale` — a 2×
 * bislerp latent upscale with a 20-step denoise-0.5 second pass (the user's tuned ComfyUI
 * workflow, translated node-for-node).
 */
export function buildWorkflow(
  positive: string,
  negative: string,
  upscale: boolean,
): { workflow: Workflow; seed: number } {
  const seed = randomSeed();
  const workflow: Workflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: cfg.checkpoint } },
    '2': { class_type: 'CLIPSetLastLayer', inputs: { stop_at_clip_layer: -2, clip: ['1', 1] } },
    '5': {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: cfg.lora,
        strength_model: cfg.loraStrength,
        strength_clip: cfg.loraStrength,
        model: ['1', 0],
        clip: ['2', 0],
      },
    },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['5', 1] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['5', 1] } },
    '7': {
      class_type: 'EmptyLatentImage',
      inputs: { width: cfg.width, height: cfg.height, batch_size: 1 },
    },
    '6': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: 30,
        cfg: 5,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['5', 0],
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['7', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'selfie', images: ['8', 0] } },
  };
  if (upscale) {
    workflow['21'] = {
      class_type: 'LatentUpscaleBy',
      inputs: { upscale_method: 'bislerp', scale_by: 2, samples: ['6', 0] },
    };
    workflow['22'] = {
      class_type: 'KSampler',
      inputs: {
        seed: randomSeed(),
        steps: 20,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 0.5,
        model: ['5', 0],
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['21', 0],
      },
    };
    workflow['8'].inputs.samples = ['22', 0];
  }
  return { workflow, seed };
}

// ---- RunPod serverless client ------------------------------------------------------------

const runpodBase = (): string => `https://api.runpod.ai/v2/${cfg.endpointId}`;
const runpodHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${cfg.runpodApiKey ?? ''}`,
  'Content-Type': 'application/json',
});

/** Worker/queue counts from the endpoint's /health, for `/img` status. Null when unreachable. */
export interface EndpointHealth {
  jobs: { completed: number; failed: number; inProgress: number; inQueue: number };
  workers: { idle: number; initializing: number; ready: number; running: number; throttled: number; unhealthy: number };
}

export async function endpointHealth(): Promise<EndpointHealth | null> {
  if (!isSelfieConfigured()) return null;
  try {
    const res = await fetch(`${runpodBase()}/health`, {
      headers: runpodHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as EndpointHealth;
  } catch {
    return null;
  }
}

interface JobStatus {
  id?: string;
  status?: string;
  delayTime?: number;
  executionTime?: number;
  error?: string;
  output?: { images?: { type: string; data: string }[] };
}

/** An `AbortError`-named error, so `/stop`-style aborts are distinguishable from failures. */
function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

/**
 * Best-effort server-side job cancel (timeout, user abort). A failed cancel is logged — an
 * orphaned job keeps billing, so it must leave a trace to look up on RunPod.
 */
async function cancelJob(jobId: string, reason: string): Promise<void> {
  try {
    const res = await fetch(`${runpodBase()}/cancel/${jobId}`, {
      method: 'POST',
      headers: runpodHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log.info(`Selfie job ${jobId} cancelled (${reason})`);
  } catch (err) {
    log.warn(`Failed to cancel selfie job ${jobId} (${reason}) — it may still be billing:`, err);
  }
}

/**
 * Fail-fast capacity check before submitting: when the endpoint has workers but every one of
 * them is throttled (no GPU to run on — the EU-CZ-1 era failure mode), a submit would just
 * sit IN_QUEUE until the full timeout. Better a failure line in ~5 s than in 5 minutes. An
 * unreachable /health is NOT proof of no capacity, so it never blocks a try; neither does an
 * all-zero worker table (a scaled-to-zero endpoint spawns its first worker on submit).
 */
async function assertCapacity(): Promise<void> {
  const health = await endpointHealth();
  if (!health) return;
  const w = health.workers;
  if (w.throttled > 0 && w.ready + w.idle + w.running + w.initializing === 0) {
    throw new Error(`No GPU capacity right now: all ${w.throttled} worker(s) throttled`);
  }
}

/**
 * Submits one workflow and polls until the job completes, fails, is aborted (`/stop` via
 * `signal`), or the wall-clock budget ({@link config.selfie.timeoutMs}) runs out — the budget
 * covers a cold worker's queue time. On timeout or abort the job is cancelled server-side so
 * an eventually-starting worker doesn't bill for a picture nobody will receive. Transient
 * poll errors are tolerated (ECONNRESETs observed in testing), but a response without a
 * `status` field is a hard failure — treating it as "still in progress" would spin the whole
 * budget on a permanently broken job (e.g. a revoked API key).
 */
async function runJob(
  workflow: Workflow,
  signal: AbortSignal | undefined,
  onSubmit: (jobId: string) => void,
): Promise<{
  buffer: Buffer;
  jobId: string;
  delayMs: number | undefined;
  execMs: number | undefined;
}> {
  if (signal?.aborted) throw abortError('Selfie aborted before submit');
  const submitRes = await fetch(`${runpodBase()}/run`, {
    method: 'POST',
    headers: runpodHeaders(),
    body: JSON.stringify({ input: { workflow } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!submitRes.ok) {
    throw new Error(`RunPod submit failed: HTTP ${submitRes.status} ${(await submitRes.text()).slice(0, 200)}`);
  }
  const submitted = (await submitRes.json()) as JobStatus;
  if (!submitted.id) throw new Error(`RunPod submit failed: ${JSON.stringify(submitted).slice(0, 200)}`);
  const jobId = submitted.id;
  onSubmit(jobId);
  log.info(`Selfie job ${jobId} submitted`);

  const deadline = Date.now() + cfg.timeoutMs;
  let job: JobStatus = submitted;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, cfg.pollMs));
    if (signal?.aborted) {
      await cancelJob(jobId, 'stopped by user');
      throw abortError(`Selfie job ${jobId} aborted`);
    }
    try {
      const res = await fetch(`${runpodBase()}/status/${jobId}`, {
        headers: runpodHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`status HTTP ${res.status}`);
      job = (await res.json()) as JobStatus;
    } catch (err) {
      log.warn(`Selfie job ${jobId} poll error (retrying):`, err);
      continue;
    }
    if (job.status === 'COMPLETED') {
      const image = job.output?.images?.find((i) => i.type === 'base64');
      if (!image) throw new Error(`Job ${jobId} completed without a base64 image`);
      log.info(`Selfie job ${jobId} done: delay ${job.delayTime}ms, exec ${job.executionTime}ms`);
      return {
        buffer: Buffer.from(image.data, 'base64'),
        jobId,
        delayMs: job.delayTime,
        execMs: job.executionTime,
      };
    }
    if (!job.status) {
      throw new Error(`Job ${jobId} returned no status: ${JSON.stringify(job).slice(0, 200)}`);
    }
    if (!['IN_QUEUE', 'IN_PROGRESS'].includes(job.status)) {
      throw new Error(`Job ${jobId} ended ${job.status}: ${JSON.stringify(job.error ?? '').slice(0, 200)}`);
    }
  }
  // Out of budget — cancel so the queued/zombie job doesn't run (and bill) pointlessly.
  await cancelJob(jobId, 'timeout');
  throw new Error(`Job ${jobId} timed out after ${Math.round(cfg.timeoutMs / 1000)}s (status ${job.status})`);
}

// ---- Generation (shared by the chat flow and /img gen) -----------------------------------

export interface GeneratedSelfie {
  buffer: Buffer;
  /** The full positive prompt the generator ran (identity + scene + quality tags). */
  tags: string;
  seed: number;
  upscaled: boolean;
  jobId: string;
  delayMs: number | undefined;
  execMs: number | undefined;
}

/** How far a failed generation got — attached to the thrown error so the photo_gens row can
 * record the jobId/seed/tags of exactly the runs you'd want to look up on RunPod. */
export interface SelfieFailInfo {
  tags?: string;
  seed?: number;
  jobId?: string;
}

/** The failure info attached by {@link generateSelfie}, or {} for errors thrown before it. */
export function selfieFailInfo(err: unknown): SelfieFailInfo {
  return (err as { selfieInfo?: SelfieFailInfo } | null)?.selfieInfo ?? {};
}

/** Runs the full prose → tags → image pipeline. Throws on any failure (with
 * {@link SelfieFailInfo} attached recording how far it got); `signal` aborts it (`/stop`). */
export async function generateSelfie(prose: string, signal?: AbortSignal): Promise<GeneratedSelfie> {
  const partial: SelfieFailInfo = {};
  try {
    await assertCapacity();
    const tags = await proseToTags(prose, signal);
    partial.tags = tags;
    const upscaled = getImgUpscale();
    const { workflow, seed } = buildWorkflow(tags, loadAppearance().negative, upscaled);
    partial.seed = seed;
    const { buffer, jobId, delayMs, execMs } = await runJob(workflow, signal, (id) => {
      partial.jobId = id;
    });
    return { buffer, tags, seed, upscaled, jobId, delayMs, execMs };
  } catch (err) {
    if (err instanceof Error) (err as Error & { selfieInfo?: SelfieFailInfo }).selfieInfo = partial;
    throw err;
  }
}

/** Saves a generated PNG under data/photos for traceability. Non-fatal: null on failure. */
export function savePng(buffer: Buffer): string | null {
  try {
    const dir = resolve(process.cwd(), cfg.photosDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Date.now()}.png`);
    writeFileSync(path, buffer);
    return path;
  } catch (err) {
    log.warn('Could not save the generated PNG locally:', err);
    return null;
  }
}

// ---- Ephemeral cues (never persisted — the ack/caption/failure lines are what's stored) ---

/**
 * The chunker-equivalent cleanup a normal streamed bubble gets, for the single-message lines
 * this file sends (photo caption, failure line): sanitize (typographic tells) + per-bubble
 * trailing-dot strip, rejoined. Without it a caption keeps its trailing period — the exact
 * tell the chunker exists to remove.
 */
function cleanLine(text: string): string {
  return splitMessage(sanitize(text)).join('\n');
}

/**
 * One-shot chat-model call: the current window plus an ephemeral cue as the trailing user
 * turn. Any stray tool-call tag in the output is stripped and the result gets the same
 * sanitize + chunker treatment as a normal bubble; empty results fall back.
 */
async function cueLine(
  systemPrompt: string,
  chatId: number,
  cue: string,
  fallback: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await chat(systemPrompt, [...getWindow(chatId), { role: 'user', content: cue }], undefined, signal);
    return cleanLine(stripToolCalls(result.content)) || fallback;
  } catch (err) {
    log.warn('Cue line generation failed, using fallback:', err);
    return fallback;
  }
}

/** The "hang on" line when the model emitted a bare tool call with no prose of its own. */
export function ackLine(systemPrompt: string, chatId: number, userName: string, prose: string): Promise<string> {
  return cueLine(systemPrompt, chatId, selfieAckCue(userName, prose), SELFIE_ACK_FALLBACK);
}

/** The line sent together with the finished photo (generated while the image renders). */
function captionLine(systemPrompt: string, chatId: number, prose: string, signal?: AbortSignal): Promise<string> {
  return cueLine(systemPrompt, chatId, selfieCaptionCue(prose), '', signal);
}

/** The in-character line for a failed generation (timeout, job error, send error). */
function failureLine(systemPrompt: string, chatId: number): Promise<string> {
  return cueLine(systemPrompt, chatId, SELFIE_FAILURE_CUE, SELFIE_FAILURE_FALLBACK);
}

// ---- The chat flow -----------------------------------------------------------------------

export interface SelfieFlowOpts {
  client: TelegramClient;
  peer: InputPeerLike;
  chatId: number;
  userName: string;
  systemPrompt: string;
  /** The model's prose description — the send_selfie `prompt` argument. */
  prose: string;
  /** `/stop`'s abort signal: cancels the booru pass, the RunPod job, and the caption pass. */
  signal?: AbortSignal;
}

/**
 * Runs one conversation-driven selfie to completion: progress panel up (ground truth that
 * the tool really fired — and a "don't bother typing yet" signal), caption generated in
 * parallel with the image, photo + caption sent as ONE Telegram message, everything
 * persisted (message row = caption; attachments row = the prose, so the window renders the
 * protocol turns — see renderSelfieWindowTurns in memory.ts; photo_gens row = full
 * traceability). On failure: panel down, an in-character line is sent and stored, and the
 * attempt is recorded as failed with whatever jobId/seed/tags it got to. A `/stop` abort
 * (via `opts.signal`) cancels the RunPod job and ends in silence — an intentional halt, not
 * a failure, so no failure line is sent.
 *
 * Runs inside the chat's queue task — messages arriving during the generation simply queue
 * behind it, which is also correct in-fiction: she's off "taking the photo".
 */
export async function runSelfieFlow(opts: SelfieFlowOpts): Promise<void> {
  const { client, peer, chatId, userName, systemPrompt, prose, signal } = opts;
  log.info(`Selfie flow for chat ${chatId}: ${prose.slice(0, 100)}`);
  await showPanel(client, peer, chatId, '📸 Making a picture…').catch(() => {});
  // The caption rides along while the image generates — its latency is fully absorbed.
  const captionPromise = captionLine(systemPrompt, chatId, prose, signal);

  const upscaled = getImgUpscale();
  try {
    const gen = await generateSelfie(prose, signal);
    const filePath = savePng(gen.buffer);
    const caption = await captionPromise;
    client.sendTyping(peer, 'upload_photo').catch(() => {});
    const sent = await client.sendMedia(
      peer,
      InputMedia.photo(gen.buffer, caption ? { caption: renderMarkdown(caption) } : {}),
    );
    const rowId = saveMessage(chatId, 'assistant', caption, [sent.id], {
      provider: activeProviderId(),
      model: null,
    });
    saveAttachment(rowId, 0, prose);
    savePhotoGen({
      chatId,
      messageId: rowId,
      prose,
      tags: gen.tags,
      seed: gen.seed,
      upscaled: gen.upscaled,
      jobId: gen.jobId,
      delayMs: gen.delayMs,
      execMs: gen.execMs,
      status: 'ok',
      filePath: filePath ?? undefined,
    });
  } catch (err) {
    const info = selfieFailInfo(err);
    const aborted = (err as { name?: string } | null)?.name === 'AbortError' || signal?.aborted;
    savePhotoGen({
      chatId,
      prose,
      tags: info.tags ?? '',
      seed: info.seed,
      jobId: info.jobId,
      upscaled,
      status: 'failed',
      error: aborted ? 'aborted by /stop' : String(err).slice(0, 500),
    });
    // Whatever the caption call produced is for a photo that doesn't exist — drop it.
    captionPromise.catch(() => {});
    if (aborted) {
      // /stop is an intentional halt: keep quiet, like an aborted text generation.
      log.info('Selfie flow stopped by user.');
      return;
    }
    log.error('Selfie flow failed:', err);
    const text = await failureLine(systemPrompt, chatId);
    try {
      const sent = await client.sendText(peer, renderMarkdown(text));
      saveMessage(chatId, 'assistant', text, [sent.id], { provider: activeProviderId(), model: null });
    } catch {
      /* the failure line failing too is just logged silence */
    }
  } finally {
    await dropPanel(client, peer, chatId).catch(() => {});
  }
}

// ---- The promise gate (detect "gimme a sec" without a tool call) -------------------------

/**
 * Cheap pre-filter for {@link maybeRepairPromise}: promise-ish language AND a visual noun,
 * both present somewhere in the reply. Tuned for recall, not precision — a false positive
 * costs one gated LLM call (~$0.00002) whose output is discarded unless it parses as a
 * valid send_selfie call, so over-matching here is harmless by construction.
 */
const PROMISE_RE = /\b(gimme a sec|give me a sec|one sec|hold on|hang on|lemme |let me |i'?ll |wait\b|brb|coming (right )?up|hold up|sec\b|moment)/i;
const VISUAL_RE = /\b(pic|pics|photo|selfie|picture|snap|show you|see me|look at me|my face|face thing|my room|my outfit|what i look|how i look)/i;

/** Whether a reply looks like it promised a picture. The LLM gate makes the real decision. */
export function looksLikePhotoPromise(replyText: string): boolean {
  return PROMISE_RE.test(replyText) && VISUAL_RE.test(replyText);
}

/**
 * The gate itself: asks the chat model to reread its just-sent reply (already in the window)
 * and either emit the send_selfie call it implicitly promised, or say no. Test results
 * (2026-07-18): clear negatives 9/9 "no", clear promises 6/6 call. The gate's text output
 * never reaches the chat — only a syntactically valid parsed call does anything.
 */
export async function maybeRepairPromise(opts: Omit<SelfieFlowOpts, 'prose'>): Promise<void> {
  if (!isSelfieAvailable()) return;
  const { systemPrompt, chatId, userName, signal } = opts;
  const cue =
    `[System note: check your previous message. If in it you told ${userName} you would send or show ` +
    'him something visual right now (a picture of yourself, your outfit, your room - your pictures ' +
    'always include you), output ONLY the send_selfie tool call for that picture. If you promised ' +
    'nothing visual, or only vaguely for later, output exactly: no]';
  let out: string;
  try {
    out = (await chat(systemPrompt, [...getWindow(chatId), { role: 'user', content: cue }], undefined, signal))
      .content;
  } catch (err) {
    log.warn('Promise gate call failed (skipping):', err);
    return;
  }
  const call = parseToolCall(out);
  if (call?.name !== 'send_selfie') {
    log.info(`Promise gate: no repair (${out.trim().slice(0, 60)})`);
    return;
  }
  const prose = String(call.arguments.prompt ?? '').trim();
  if (!prose) return;
  log.info('Promise gate: repairing an uncalled photo promise');
  await runSelfieFlow({ ...opts, prose });
}
