/**
 * Regression check for the context-aware `/reroll` — the three reach-out kinds.
 *
 * `/reroll` on a bot-initiated opener must rebuild the director cue the row was generated
 * against (see proactive.ts:buildReachoutCue) instead of answering the user's last message,
 * with the long-term-memory block withheld exactly as the original send had it. This asserts
 * the pieces that decision rests on: the stored kind, its resolution (including the legacy
 * fallback for rows written before the column existed), the window exclusion, and the cue.
 *
 * Seeds rows into a chat and deletes them again, so run it against a THROWAWAY COPY:
 *
 *   rm -f /tmp/t.db*; cp data/userbot.db /tmp/t.db
 *   DB_PATH=/tmp/t.db npx tsx scripts/reroll-test.ts
 *
 * (Delete the copy's `-wal`/`-shm` files too — a stale WAL replays the previous run's rows
 * over the fresh copy.) `LIVE=1` additionally generates one opener per kind through the
 * configured provider, so you can read whether they came back as openers or as replies.
 */
import { resolve } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { db, runMigrations } from '../src/db/index.js';
import { isReachoutKind, messages, summaries, type MessageKind } from '../src/db/schema.js';
import { config } from '../src/config.js';
import {
  getLastAssistant,
  getWindow,
  getWindowExcluding,
  saveMessage,
  getSummaryState,
} from '../src/memory.js';
import { buildReachoutCue, reachoutKindOf, type ReachoutKind } from '../src/proactive.js';
import { ephemeralSearchStrategy, generateReply } from '../src/generate.js';
import { renderSystemPrompt } from '../src/prompts/render.js';
import { initProvider } from '../src/llm.js';
import { initPersona } from '../src/persona.js';
import { initSettings } from '../src/settings.js';

// This script writes to the database it is pointed at. Refuse to touch the real one: a throw
// anywhere past the seeding (a provider error in the LIVE block, most plausibly) would strand
// rows flagged proactive, which getRecentOpeners then hands to the model as openers not to
// repeat, and which the window carries as real history.
const dbPath = process.env.DB_PATH;
if (!dbPath || resolve(dbPath) === resolve('data/userbot.db')) {
  console.error('Refusing to run against the live database. Point DB_PATH at a throwaway copy:');
  console.error('  rm -f /tmp/t.db*; cp data/userbot.db /tmp/t.db');
  console.error('  DB_PATH=/tmp/t.db npx tsx scripts/reroll-test.ts');
  process.exit(1);
}

runMigrations();
initPersona();
initSettings();
const chatId = [...config.whitelist][0];
const userName = getSummaryState(chatId)?.userName ?? 'user';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const KINDS: ReachoutKind[] = ['reachout_morning', 'reachout_lull', 'reachout_ignored'];
const SIGNATURE: Record<string, RegExp> = {
  reachout_morning: /it's morning and .* hasn't messaged yet/,
  reachout_lull: /there's a natural lull/,
  reachout_ignored: /you already reached out a little while ago/,
};

const seeded: number[] = [];
let summaryId: number | null = null;

/** Removes every row this run created. Runs even when a check or a live call throws. */
function cleanup(): void {
  if (seeded.length) db.delete(messages).where(inArray(messages.id, seeded)).run();
  if (summaryId !== null) db.delete(summaries).where(eq(summaries.id, summaryId)).run();
}
process.on('exit', cleanup);
process.on('uncaughtException', (err) => {
  console.error(err);
  process.exit(1);
});

function seed(kind: MessageKind, text: string): number {
  const id = saveMessage(chatId, 'assistant', text, [999_000 + seeded.length], undefined, kind);
  seeded.push(id);
  return id;
}

// ---- 1. kind round-trip + derived proactive flag ------------------------------------------
console.log('\n== 1. storage ==');
for (const kind of KINDS) {
  const id = seed(kind, `seeded ${kind} opener`);
  const row = db.select().from(messages).where(eq(messages.id, id)).get()!;
  check(`${kind}: stored kind`, row.kind === kind, row.kind);
  check(`${kind}: proactive derived true`, row.proactive === true);
}
const replyId = saveMessage(chatId, 'assistant', 'a plain reactive reply', [999_100]);
seeded.push(replyId);
const replyRow = db.select().from(messages).where(eq(messages.id, replyId)).get()!;
check('reply: kind defaults to reply', replyRow.kind === 'reply');
check('reply: proactive stays false', replyRow.proactive === false);

// ---- 2. reachoutKindOf resolution ----------------------------------------------------------
console.log('\n== 2. kind resolution ==');
for (const kind of KINDS) {
  check(`${kind} resolves to itself`, reachoutKindOf(kind) === kind);
}
check('plain reply resolves to null', reachoutKindOf('reply') === null);
// A row written before the kind column carries proactive=true and kind='reply'. Its framing was
// never recorded and is deliberately not guessed at, so it rerolls as an ordinary reply.
const legacyId = saveMessage(chatId, 'assistant', 'a legacy opener', [999_200]);
seeded.push(legacyId);
db.update(messages).set({ proactive: true }).where(eq(messages.id, legacyId)).run();
const legacyRow = getLastAssistant(chatId)!;
check('legacy row is still flagged proactive', legacyRow.kind === 'reply');
check('legacy row takes the reactive path', reachoutKindOf(legacyRow.kind) === null);
// A future non-reach-out kind must not flip the proactive flag (which feeds the openers clause).
check('isReachoutKind: reply is not a reach-out', !isReachoutKind('reply'));
check('isReachoutKind: all three reach-outs are', KINDS.every(isReachoutKind));

// ---- 3. window exclusion --------------------------------------------------------------------
console.log('\n== 3. window exclusion ==');
const firstOpener = seed('reachout_lull', 'FIRSTOPENER unanswered one');
const secondOpener = seed('reachout_ignored', 'SECONDOPENER the one being rerolled');
const full = getWindow(chatId).map((m) => m.content).join('\n');
const trimmed = getWindowExcluding(chatId, secondOpener).map((m) => m.content).join('\n');
check('full window has both openers', full.includes('FIRSTOPENER') && full.includes('SECONDOPENER'));
check('excluding drops only the target', trimmed.includes('FIRSTOPENER') && !trimmed.includes('SECONDOPENER'));
check(
  'exactly one turn removed',
  getWindow(chatId).length - getWindowExcluding(chatId, secondOpener).length === 1,
);

// ---- 4. cue rebuild -------------------------------------------------------------------------
console.log('\n== 4. cue rebuild ==');
for (const kind of KINDS) {
  const cue = buildReachoutCue(chatId, kind, userName);
  check(`${kind}: correct cue text`, SIGNATURE[kind].test(cue));
  check(`${kind}: lists the opener being replaced`, cue.includes('SECONDOPENER'));
}
// The lull shape is rolled per call — a spree must not redraw the same one every time.
const shapes = new Set(
  Array.from({ length: 20 }, () =>
    buildReachoutCue(chatId, 'reachout_lull', userName).slice(0, 220),
  ),
);
check('lull shape varies across rerolls', shapes.size > 1, `${shapes.size} distinct in 20 draws`);

// ---- 5. what /reroll would actually feed the model -------------------------------------------
console.log('\n== 5. reroll context ==');
const last = getLastAssistant(chatId)!;
check('getLastAssistant reports the kind', last.kind === 'reachout_ignored', last.kind);
const resolved = reachoutKindOf(last.kind);
// The dev DB has no summaries, so seed one — otherwise the memory block is empty either way
// and the assertion would pass vacuously.
const dayStart = new Date().setHours(0, 0, 0, 0) - 86_400_000;
summaryId = db
  .insert(summaries)
  .values({
    chatId,
    level: 0,
    periodStart: dayStart,
    periodEnd: dayStart + 86_400_000,
    content: 'MEMORYPROBE headline / happened / mood / follow-ups',
  })
  .returning({ id: summaries.id })
  .get().id;
const systemPrompt = renderSystemPrompt({ userName, chatId }, { includeMemory: !resolved });
const withMemory = renderSystemPrompt({ userName, chatId }, { includeMemory: true });
check('control: memory block present when included', withMemory.includes('MEMORYPROBE'));
check(
  'memory block withheld on a reach-out reroll',
  !systemPrompt.includes('MEMORYPROBE') && !systemPrompt.includes('# Memory'),
  `${systemPrompt.length} vs ${withMemory.length} chars`,
);
// A plain reply reroll must still get it.
check(
  'memory block kept on an ordinary reply reroll',
  renderSystemPrompt({ userName, chatId }, { includeMemory: true }).includes('MEMORYPROBE'),
);

// ---- 6. live generations ---------------------------------------------------------------------
if (process.env.LIVE) {
  console.log('\n== 6. live generations ==');
  await initProvider();
  for (const kind of KINDS) {
    db.update(messages).set({ kind }).where(eq(messages.id, secondOpener)).run();
    const row = getLastAssistant(chatId)!;
    const k = reachoutKindOf(row.kind)!;
    const sys = renderSystemPrompt({ userName, chatId }, { includeMemory: false });
    const out = await generateReply(
      sys,
      ephemeralSearchStrategy(chatId, buildReachoutCue(chatId, k, userName), { excludeId: row.id }),
      `reroll-test ${k}`,
    );
    console.log(`\n--- ${k} ---\n${out.content.trim()}`);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
