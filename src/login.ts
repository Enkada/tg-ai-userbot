import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient } from '@mtcute/node';
import { config } from './config.js';

/**
 * One-time interactive login script.
 *
 * Run this WITHOUT watch mode (it is wired to `npm run login`). It performs the
 * MTProto sign-in, persists the session to `config.sessionPath`, then exits.
 * After this succeeds, `npm run dev` / `npm run start` connect without prompting.
 *
 * We use our own `readline/promises` interface here (instead of mtcute's built-in
 * prompt) so stdin handling is explicit and reliable across terminals.
 */

const rl = createInterface({ input, output });

const client = new TelegramClient({
  apiId: config.apiId,
  apiHash: config.apiHash,
  storage: config.sessionPath,
});

async function ask(question: string): Promise<string> {
  // Loop until we get a non-empty answer, so an accidental Enter doesn't submit blank.
  for (;;) {
    const answer = (await rl.question(question)).trim();
    if (answer) return answer;
    console.log('(empty input — please try again)');
  }
}

try {
  console.log(`Signing in as ${config.phone} ...`);
  console.log('Telegram will send a login code to your Telegram app (or SMS).');

  const self = await client.start({
    phone: config.phone,
    code: () => ask('Enter the login code: '),
    password: () => ask('Enter your 2FA password: '),
  });

  const name = self.displayName ?? self.username ?? String(self.id);
  console.log(`\n✅ Logged in as ${name} (id: ${self.id})`);
  console.log(`Session saved to ${config.sessionPath}. You can now run "npm run dev".`);
} catch (err) {
  console.error('\n❌ Login failed:', err);
  process.exitCode = 1;
} finally {
  rl.close();
  await client.destroy();
  process.exit(process.exitCode ?? 0);
}
