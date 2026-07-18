/**
 * Selfies: the `send_selfie` tool — RunPod serverless ComfyUI image generation.
 *
 * The pipeline, per picture: the chat model calls the tool with a plain-prose description
 * ("selfie of me on my bed, default clothes, smirk, night") → the *booru pass* (a cheap
 * dedicated model, see prompts/booru.txt) converts prose to a Danbooru tag prompt opened by
 * the character's fixed identity tags (prompts/appearance.txt) → a ComfyUI workflow is built
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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InputMedia, type InputPeerLike, type TelegramClient } from '@mtcute/node';
import { fetch } from 'undici';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { activeProviderId, chat } from './llm.js';
import { booruPass } from './providers/openrouter.js';
import {
  getWindow,
  photosToday,
  saveAttachment,
  saveMessage,
  savePhotoGen,
} from './memory.js';
import { dropPanel, showPanel } from './panel.js';
import { getImgUpscale } from './settings.js';
import { renderMarkdown } from './format.js';
import { parseToolCall, stripToolCalls } from './tools.js';

const log = createLogger('selfie');

const cfg = config.selfie;

/** Whether the feature exists at all: RunPod credentials + OpenRouter (for the booru pass). */
export function isSelfieConfigured(): boolean {
  return Boolean(cfg.runpodApiKey && cfg.endpointId && config.llm.openrouter.apiKey);
}

/**
 * Whether the tool may be offered right now: configured AND under the daily cap. Checked at
 * prompt-render time — once the cap is hit the tool (and its prompt section) simply
 * disappears, so the model can't call it and no per-call refusal path is needed.
 */
export function isSelfieAvailable(): boolean {
  return isSelfieConfigured() && photosToday() < cfg.dailyCap;
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
 * Parses prompts/appearance.txt. Lazy + cached — the file is user-tuned content, but like
 * the other prompt layers it's read once per process (a deploy restarts the process anyway).
 */
function loadAppearance(): Appearance {
  if (appearanceCache) return appearanceCache;
  const raw = readFileSync(resolve(process.cwd(), cfg.appearancePath), 'utf8');
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

let booruTemplate: string | undefined;

/**
 * Converts the model's prose description into the full positive tag prompt (identity tags
 * first, quality tags appended). Throws when the pass returns something that can't be a tag
 * line for this character — the flow treats that as a failed generation.
 */
export async function proseToTags(prose: string): Promise<string> {
  const app = loadAppearance();
  if (booruTemplate === undefined) {
    booruTemplate = readFileSync(resolve(process.cwd(), cfg.promptPath), 'utf8').trim();
  }
  const system = booruTemplate
    .replace(/\{\{\s*identity\s*\}\}/g, app.identity)
    .replace(/\{\{\s*outfit_(\w+)\s*\}\}/g, (m, name: string) => app.outfits.get(name.toLowerCase()) ?? m);
  const out = (await booruPass(system, prose)).trim().replace(/\s*\n+\s*/g, ' ');
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

/**
 * Submits one workflow and polls until the job completes, fails, or the wall-clock budget
 * ({@link config.selfie.timeoutMs}) runs out — the budget is generous because a cold worker
 * after idle measured 200+ s of queue time before ~54 s of execution. On timeout the job is
 * cancelled server-side so an eventually-starting worker doesn't bill for a picture nobody
 * will receive. Poll errors are tolerated (transient ECONNRESETs observed in testing).
 */
async function runJob(workflow: Workflow): Promise<{
  buffer: Buffer;
  jobId: string;
  delayMs: number | undefined;
  execMs: number | undefined;
}> {
  const submitted = (await (
    await fetch(`${runpodBase()}/run`, {
      method: 'POST',
      headers: runpodHeaders(),
      body: JSON.stringify({ input: { workflow } }),
      signal: AbortSignal.timeout(15_000),
    })
  ).json()) as JobStatus;
  if (!submitted.id) throw new Error(`RunPod submit failed: ${JSON.stringify(submitted).slice(0, 200)}`);
  const jobId = submitted.id;
  log.info(`Selfie job ${jobId} submitted`);

  const deadline = Date.now() + cfg.timeoutMs;
  let job: JobStatus = submitted;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, cfg.pollMs));
    try {
      job = (await (
        await fetch(`${runpodBase()}/status/${jobId}`, {
          headers: runpodHeaders(),
          signal: AbortSignal.timeout(10_000),
        })
      ).json()) as JobStatus;
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
    if (job.status && !['IN_QUEUE', 'IN_PROGRESS'].includes(job.status)) {
      throw new Error(`Job ${jobId} ended ${job.status}: ${JSON.stringify(job.error ?? '').slice(0, 200)}`);
    }
  }
  // Out of budget — cancel so the queued/zombie job doesn't run (and bill) pointlessly.
  await fetch(`${runpodBase()}/cancel/${jobId}`, {
    method: 'POST',
    headers: runpodHeaders(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
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

/** Runs the full prose → tags → image pipeline. Throws on any failure. */
export async function generateSelfie(prose: string): Promise<GeneratedSelfie> {
  const tags = await proseToTags(prose);
  const upscaled = getImgUpscale();
  const { workflow, seed } = buildWorkflow(tags, loadAppearance().negative, upscaled);
  const { buffer, jobId, delayMs, execMs } = await runJob(workflow);
  return { buffer, tags, seed, upscaled, jobId, delayMs, execMs };
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
 * One-shot chat-model call: the current window plus an ephemeral cue as the trailing user
 * turn. Any stray tool-call tag in the output is stripped; empty results fall back.
 */
async function cueLine(systemPrompt: string, chatId: number, cue: string, fallback: string): Promise<string> {
  try {
    const result = await chat(systemPrompt, [...getWindow(chatId), { role: 'user', content: cue }]);
    return stripToolCalls(result.content).trim() || fallback;
  } catch (err) {
    log.warn('Cue line generation failed, using fallback:', err);
    return fallback;
  }
}

/** The "hang on" line when the model emitted a bare tool call with no prose of its own. */
export function ackLine(systemPrompt: string, chatId: number, userName: string, prose: string): Promise<string> {
  return cueLine(
    systemPrompt,
    chatId,
    `[System note: your picture is being made: "${prose}". Say one short line telling ${userName} to hang on while you take it - your usual voice, nothing else.]`,
    'gimme a sec',
  );
}

/** The line sent together with the finished photo (generated while the image renders). */
function captionLine(systemPrompt: string, chatId: number, prose: string): Promise<string> {
  return cueLine(
    systemPrompt,
    chatId,
    `[System note: you made the picture and are sending it now: "${prose}". Write the one short line you send with it - your usual voice, nothing else.]`,
    '',
  );
}

/** The in-character line for a failed generation (timeout, job error, send error). */
function failureLine(systemPrompt: string, chatId: number): Promise<string> {
  return cueLine(
    systemPrompt,
    chatId,
    '[System note: the picture you tried to make did not come out - say one short line brushing it off, nothing else. Do not promise another one right now.]',
    "ugh, it came out cursed. not sending that",
  );
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
}

/**
 * Runs one conversation-driven selfie to completion: progress panel up (ground truth that
 * the tool really fired — and a "don't bother typing yet" signal), caption generated in
 * parallel with the image, photo + caption sent as ONE Telegram message, everything
 * persisted (message row = caption; attachments row = the prose, so the window shows
 * `[you sent a photo: …]`; photo_gens row = full traceability). On failure: panel down,
 * an in-character line is sent and stored, and the attempt is recorded as failed (it still
 * counts toward the daily cap so a broken endpoint can't burn unlimited retries).
 *
 * Runs inside the chat's queue task — messages arriving during the ~20-300s generation
 * simply queue behind it, which is also correct in-fiction: she's off "taking the photo".
 */
export async function runSelfieFlow(opts: SelfieFlowOpts): Promise<void> {
  const { client, peer, chatId, userName, systemPrompt, prose } = opts;
  log.info(`Selfie flow for chat ${chatId}: ${prose.slice(0, 100)}`);
  await showPanel(client, peer, chatId, '📸 Making a picture…').catch(() => {});
  // The caption rides along while the image generates — its latency is fully absorbed.
  const captionPromise = captionLine(systemPrompt, chatId, prose);

  let tags = '';
  const upscaled = getImgUpscale();
  try {
    const gen = await generateSelfie(prose);
    tags = gen.tags;
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
    log.error('Selfie flow failed:', err);
    savePhotoGen({
      chatId,
      prose,
      tags,
      upscaled,
      status: 'failed',
      error: String(err).slice(0, 500),
    });
    // Whatever the caption call produced is for a photo that doesn't exist — drop it.
    captionPromise.catch(() => {});
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
  const { systemPrompt, chatId, userName } = opts;
  const cue =
    `[System note: check your previous message. If in it you told ${userName} you would send or show ` +
    'him something visual right now (a picture of yourself, your outfit, your room - your pictures ' +
    'always include you), output ONLY the send_selfie tool call for that picture. If you promised ' +
    'nothing visual, or only vaguely for later, output exactly: no]';
  let out: string;
  try {
    out = (await chat(systemPrompt, [...getWindow(chatId), { role: 'user', content: cue }])).content;
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
