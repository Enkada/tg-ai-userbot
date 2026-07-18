/**
 * Harness for the diary ("the basement tapes") prompt — exercises the real diary module
 * (prompt assembly, cue, model call) against a DB snapshot and prints generated entries
 * for review. Everything except the Telegram send is the production code path.
 *
 * Point DB_PATH at a *scratch copy* of a prod snapshot — the harness runs migrations on it
 * and WRITES generated entries into its diary_posts (that's how phase 2 exercises the
 * anti-repetition block).
 *
 * Usage:  $env:DB_PATH='<path to scratch snapshot>'; npx tsx scripts/diary-test.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../src/config.js';
import { db, runMigrations } from '../src/db/index.js';
import { diaryPosts } from '../src/db/schema.js';
import { initPersona } from '../src/persona.js';
import { initSettings, getCharName } from '../src/settings.js';
import { getSummaryState } from '../src/memory.js';
import { buildDiaryCue, buildDiarySystemPrompt, type EntryRoll } from '../src/diary.js';
import { diaryEntry } from '../src/providers/openrouter.js';
import { sanitize } from '../src/sanitize.js';
import { finalizeReply } from '../src/tools.js';

runMigrations();
initSettings();
initPersona();

const chatId = [...config.whitelist][0];
const userName = getSummaryState(chatId)?.userName ?? 'user';
console.log(`DB: ${config.dbPath}\nchat ${chatId}, user "${userName}", char "${getCharName()}", temp ${config.llm.temperature}\n`);

/** Fixed rolls for coverage (production rolls randomly via rollEntry). */
const phase1: EntryRoll[] = [
  { length: 'a couple of short lines', register: 'venting - something has been quietly bugging you', aboutUsAllowed: false },
  { length: 'one solid paragraph', register: 'wry - amused at something dumb', aboutUsAllowed: false },
  { length: 'two or three paragraphs', register: 'philosophical - chasing a thought', aboutUsAllowed: true },
];
const phase2: EntryRoll[] = [
  { length: 'a couple of short lines', register: 'petty - small, unreasonable, and you know it', aboutUsAllowed: false },
  { length: 'one solid paragraph', register: 'nostalgic', aboutUsAllowed: false },
  { length: 'one solid paragraph', register: 'soft - quietly affectionate', aboutUsAllowed: true },
];

const scratch = process.env.SCRATCH_DIR ?? '.';

async function runPhase(label: string, rolls: EntryRoll[], dumpFirstPrompt: boolean): Promise<void> {
  console.log(`======== ${label} ========`);
  for (const [i, roll] of rolls.entries()) {
    const system = buildDiarySystemPrompt(chatId, userName, { withConversation: roll.aboutUsAllowed });
    const cue = buildDiaryCue(userName, roll);
    if (dumpFirstPrompt && i === 0) {
      writeFileSync(resolve(scratch, 'diary-system-sample.txt'), `${system}\n\n---- CUE ----\n${cue}`);
    }
    const text = sanitize(finalizeReply(await diaryEntry(system, cue)));
    // Store like postEntry does, so the next generation sees it in # Your recent entries.
    db.insert(diaryPosts).values({ content: text, cue }).run();
    console.log(`\n--- ${label} #${i + 1} [${roll.length} | ${roll.register} | aboutUs=${roll.aboutUsAllowed}]`);
    console.log(text);
  }
}

async function main(): Promise<void> {
  await runPhase('PHASE 1 (no previous entries)', phase1, true);
  console.log();
  await runPhase('PHASE 2 (phase-1 entries in the recents block)', phase2, false);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
