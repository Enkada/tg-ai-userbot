/**
 * Replay bench — regenerates real historical replies through the production prompt path, with
 * optional ablations, and writes one JSON line per sample. The general-purpose tool behind the
 * 2026-10-03 persona/tic/gap evals (docs/development/evals.md has the workflow).
 *
 * Each position is an assistant message id: every row from that id on is hidden in the scratch DB
 * (cue-test.ts:atPosition), so the window, memory block and tail cue are exactly what prod would
 * have built at that moment. Summaries/facts written after the moment are hidden too.
 *
 *   DB_PATH=<scratch copy of a prod snapshot>   required — the harness WRITES to it
 *   IDS=4364,4401,…          assistant message ids to regenerate
 *   MODELS=a,b,…             OpenRouter slugs; repeat a slug for several samples (default prod model)
 *   OUT=results.jsonl        appended to
 *   PERSONA_FILE=v22.txt     optional: inserted as the newest persona_versions row before loading
 *   NOGAP=1 / NOMEM=1 / NOAVOID=1   ablations: drop the gap clause / # Memory block / tic avoid-list
 *   DRY=1                    print prompt sizes, write prompt-<id>.txt next to OUT, no API calls
 *
 *   npx tsx scripts/replay.ts
 *
 * Never point two concurrent runs at the same DB file — positions flip `deleted` flags in place.
 * Use one DB copy per arm, or run arms sequentially.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const dbPath = process.env.DB_PATH;
if (!dbPath) throw new Error('DB_PATH must point at a scratch copy of the DB');
if (resolve(dbPath) === resolve('data/userbot.db')) throw new Error('refusing to run against data/userbot.db');

// Persona override goes in before any app module loads (initPersona caches the newest row).
if (process.env.PERSONA_FILE) {
  const text = readFileSync(process.env.PERSONA_FILE, 'utf8').trim();
  const raw = new Database(dbPath);
  raw.prepare("insert into persona_versions (content, source) values (?, 'bench')").run(text);
  raw.close();
}

const { config } = await import('../src/config.js');
const { db } = await import('../src/db/index.js');
const { conversationGapMs, getWindow } = await import('../src/memory.js');
const { renderSystemPrompt } = await import('../src/prompts/render.js');
const { avoidListFor, withReplyCue } = await import('../src/generate.js');
const { atPosition, chatId, positions, userName } = await import('./cue-test.js');

const cfg = config.llm.openrouter;
const IDS = (process.env.IDS ?? '').split(',').filter(Boolean).map(Number);
if (IDS.length === 0) throw new Error('IDS is empty');
const MODELS = (process.env.MODELS ?? cfg.model).split(',');
const OUT = process.env.OUT ?? 'replay.jsonl';
const DRY = process.env.DRY === '1';
const NOGAP = process.env.NOGAP === '1';
const NOMEM = process.env.NOMEM === '1';
const NOAVOID = process.env.NOAVOID === '1';

type Msg = { role: string; content: string };

/** Request body per model. The prod model keeps prod routing; others go latency-first. */
function bodyFor(model: string, system: string, history: Msg[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: system }, ...history],
    stream: true,
    temperature: config.llm.temperature,
    top_p: config.llm.topP,
    min_p: config.llm.minP,
    presence_penalty: config.llm.presencePenalty,
    frequency_penalty: config.llm.frequencyPenalty,
    max_tokens: 1024,
    reasoning: { enabled: false },
    usage: { include: true },
  };
  body.provider = model === cfg.model ? { order: cfg.providerOrder, allow_fallbacks: true } : { sort: 'latency', allow_fallbacks: true };
  // Models that reject `enabled:false` (found 2026-10-03): ask for the minimum instead.
  if (/gemini|gpt-6|kimi-k3|grok/.test(model)) body.reasoning = { effort: 'minimal' };
  if (/glm-5\.3$|claude-sonnet-5|claude-opus/.test(model)) body.reasoning = { effort: 'low' };
  if (/claude/.test(model)) delete body.top_p;
  return body;
}

async function generate(model: string, system: string, history: Msg[]) {
  const t0 = Date.now();
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'tg-ai-userbot-replay' },
    body: JSON.stringify(bodyFor(model, system, history)),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 400)}`);
  let firstContent = 0, content = '', provider = '', finish = '';
  let usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null = null;
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop()!;
    for (const l of lines) {
      if (!l.startsWith('data: ') || l === 'data: [DONE]') continue;
      let j: any;
      try { j = JSON.parse(l.slice(6)); } catch { continue; }
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 300));
      if (j.provider) provider = j.provider;
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (ch?.finish_reason) finish = ch.finish_reason;
      if (ch?.delta?.content) {
        if (!firstContent) firstContent = Date.now() - t0;
        content += ch.delta.content;
      }
    }
  }
  return { content, provider, finish, ttftMs: firstContent, totalMs: Date.now() - t0, promptTok: usage?.prompt_tokens ?? null, complTok: usage?.completion_tokens ?? null, cost: usage?.cost ?? null };
}

/** Hide summaries/facts written after the replayed moment — they'd leak the future. */
function hideFuture(at: number): () => void {
  const c = (db as any).$client;
  const s = c.prepare('select id from summaries where deleted = 0 and created_at > ?').all(at).map((r: any) => r.id);
  const f = c.prepare('select id from facts where deleted = 0 and created_at > ?').all(at).map((r: any) => r.id);
  const set = (t: string, v: number, ids: number[]) => { for (const id of ids) c.prepare(`update ${t} set deleted = ? where id = ?`).run(v, id); };
  set('summaries', 1, s);
  set('facts', 1, f);
  return () => { set('summaries', 0, s); set('facts', 0, f); };
}

for (const pos of positions(IDS)) {
  const restore = hideFuture(pos.createdAt);
  try {
    await atPosition(pos.targetId, async () => {
      const now = new Date(pos.createdAt);
      const system = renderSystemPrompt({ userName, chatId }, { includeMemory: !NOMEM, now });
      const history = withReplyCue(getWindow(chatId), userName, {
        now,
        gapMs: NOGAP ? null : conversationGapMs(chatId, pos.createdAt),
        avoid: NOAVOID ? '' : avoidListFor(chatId),
      });
      const approx = Math.round((system.length + history.reduce((a, m) => a + m.content.length, 0)) / 4);
      console.log(`#${pos.targetId}: ~${approx} tok, ${history.length} msgs. HIM: ${pos.userMessage.slice(0, 80)}`);
      if (DRY) {
        writeFileSync(join(dirname(resolve(OUT)), `prompt-${pos.targetId}.txt`), `${system}\n\n=====HISTORY=====\n${history.map((m) => `[${m.role}] ${m.content}`).join('\n')}`);
        return;
      }
      await Promise.all(
        MODELS.map(async (model) => {
          let row: Record<string, unknown> = {};
          for (let attempt = 0; attempt < 2; attempt++) {
            try { row = { pos: pos.targetId, model, ...(await generate(model, system, history)) }; break; }
            catch (e) { row = { pos: pos.targetId, model, error: String(e) }; await new Promise((r) => setTimeout(r, 1500)); }
          }
          appendFileSync(OUT, JSON.stringify({ ...row, userMessage: pos.userMessage, accepted: pos.accepted }) + '\n');
          console.log(`  ${model}: ${row.error ? `ERR ${String(row.error).slice(0, 150)}` : String(row.content).replace(/\n/g, ' / ').slice(0, 160)}`);
        }),
      );
    });
  } finally {
    restore();
  }
}
