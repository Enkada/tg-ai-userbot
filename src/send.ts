/**
 * Streams an assistant reply to a chat as it is generated, one bubble at a time.
 *
 * A {@link ReplyStreamer} is created per reply and threaded into the model call as the token
 * sink. As tokens arrive it (a) decides whether the current completion is a `<tool_call>` —
 * which must never be shown — or prose, and (b) for prose, feeds the live text through an
 * incremental {@link SentenceSplitter} and sends each completed sentence as its own message.
 *
 * Bubbles are paced like someone typing the next one: the gap before a bubble is
 * `base + length × perChar` (capped), minus time already elapsed since the previous send (or,
 * for the first bubble, since the streamer was created — i.e. since generation began). So a
 * slow generation/send is never padded further (MAX(elapsed, computed delay)), the first
 * bubble appears promptly when generation was slow yet still gets a natural typing beat when
 * it was fast, and the "typing…" status is kept up across each wait.
 *
 * Tool-call awareness fits the search loop: each completion is sniffed independently
 * ({@link beginPass} resets the sniff state), so the intermediate tool-call passes are
 * suppressed and only the final prose pass is streamed. {@link finalize} flushes the last
 * sentence, and if *nothing* was streamed (every pass was a tool call, or the model answered
 * with only a suppressed/empty call) it sends the caller's finalized text as bubbles instead.
 */
import type { InputPeerLike, TelegramClient } from '@mtcute/node';
import { config } from './config.js';
import { SentenceSplitter, splitMessage } from './chunker.js';
import { renderMarkdown } from './format.js';
import { sanitize } from './sanitize.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Simulated time to "type" a bubble of `length` chars: base + length × perChar, capped. */
function typingDelayMs(length: number): number {
  const { delayBaseMs, delayPerCharMs, delayMaxMs } = config.streaming;
  return Math.min(delayMaxMs, delayBaseMs + length * delayPerCharMs);
}

/** The marker that opens a tool call; a completion starting with it is control flow, not prose. */
const TOOL_CALL_MARKER = '<tool_call>';

export class ReplyStreamer {
  private readonly splitter = new SentenceSplitter();
  private readonly sentIds: number[] = [];
  private lastEventAt = Date.now();
  private sentAny = false;
  private streamed = '';
  private stopped = false;

  // Per-completion sniff state (reset by beginPass): is this pass prose or a tool call?
  private decided: 'unknown' | 'prose' | 'tool' = 'unknown';
  private pending = '';

  /**
   * @param onFirstBubble Optional hook awaited once, right before the very first bubble is
   *   sent. `/reroll` uses it to revoke the old reply's bubbles (and the `/r` command) only
   *   when there's a new bubble to replace them — so a clean swap, and nothing is removed if
   *   generation fails before producing anything.
   */
  constructor(
    private readonly client: TelegramClient,
    private readonly peer: InputPeerLike,
    private readonly onFirstBubble?: () => void | Promise<void>,
  ) {}

  /** Telegram ids of the bubbles sent so far (for persistence and partial-failure recovery). */
  get ids(): number[] {
    return this.sentIds;
  }

  /** All prose streamed so far — used to persist a reply that failed partway through. */
  get streamedText(): string {
    return this.streamed;
  }

  /**
   * Stop sending any further bubbles (`/stop`). The in-flight model call is aborted separately;
   * this guards the send side so no bubble already in the pipeline — including one mid typing-
   * pause — reaches the chat after the user asked to stop. Whatever landed before this stays.
   */
  stop(): void {
    this.stopped = true;
  }

  /** Reset tool-call sniffing before each streamed completion in a tool loop. */
  beginPass(): void {
    this.decided = 'unknown';
    this.pending = '';
  }

  /** Token sink passed to `chat()`: suppresses tool-call passes, streams prose as bubbles. */
  readonly onToken = async (delta: string): Promise<void> => {
    if (this.decided === 'tool') return;
    if (this.decided === 'prose') {
      await this.feed(delta);
      return;
    }
    // Undecided: buffer until we can tell a tool call from prose by the leading characters.
    this.pending += delta;
    const head = this.pending.trimStart();
    if (head.length === 0) return; // only whitespace so far
    if (head.startsWith(TOOL_CALL_MARKER)) {
      this.decided = 'tool';
      return;
    }
    if (TOOL_CALL_MARKER.startsWith(head)) return; // still could become the marker; wait
    // Anything else is prose: commit and flush what we buffered.
    this.decided = 'prose';
    const buffered = this.pending;
    this.pending = '';
    await this.feed(buffered);
  };

  /** Push prose text through the splitter, sending each completed bubble. */
  private async feed(text: string): Promise<void> {
    this.streamed += text;
    for (const bubble of this.splitter.push(text)) await this.sendClean(bubble);
  }

  /**
   * Sanitize a bubble and re-split before sending. The raw stream is chunked unsanitized, and
   * sanitizing can surface a boundary the raw text hid — `2025."` becomes `2025".`, whose
   * trailing dot only a fresh split pass strips — so a single raw bubble may become several
   * clean ones. Without this, sanitize would run only inside {@link renderMarkdown}, *after*
   * the splitter, and the moved dot would reach the chat.
   */
  private async sendClean(bubble: string): Promise<void> {
    for (const piece of splitMessage(sanitize(bubble))) await this.send(piece);
  }

  /** Send one bubble, pacing it like typing and keeping "typing…" up across the wait. */
  private async send(chunk: string): Promise<void> {
    // Stopped by /stop: drop this bubble and every one after it.
    if (this.stopped) return;
    // Fire the one-shot pre-send hook the moment we have a bubble to show (e.g. /reroll clears
    // the old reply here, so the swap is clean and nothing is removed if generation produced none).
    if (!this.sentAny && this.onFirstBubble) await this.onFirstBubble();
    const idle = typingDelayMs(chunk.length) - (Date.now() - this.lastEventAt);
    if (idle > 0) {
      this.client.sendTyping(this.peer, 'typing').catch(() => {});
      await sleep(idle);
    }
    // /stop may have landed during the typing pause — re-check before the message actually goes out.
    if (this.stopped) return;
    const sent = await this.client.sendText(this.peer, renderMarkdown(chunk));
    this.sentIds.push(sent.id);
    this.lastEventAt = Date.now();
    this.sentAny = true;
  }

  /**
   * Finish the reply and return every bubble id. Flushes the last streamed sentence; if no
   * prose was ever streamed (the reply was only a tool call, hit the cap, or was a suppressed
   * malformed call), `finalText` — the caller's finalized reply — is sent as bubbles instead,
   * so the user always sees something. Never sends nothing for a non-empty `finalText`.
   */
  async finalize(finalText: string): Promise<number[]> {
    if (this.decided !== 'tool') {
      if (this.pending) {
        await this.feed(this.pending);
        this.pending = '';
      }
      for (const bubble of this.splitter.flush()) await this.sendClean(bubble);
    }
    if (!this.sentAny) {
      const bubbles = splitMessage(sanitize(finalText));
      for (const bubble of bubbles.length ? bubbles : [finalText.trim() || '…']) await this.send(bubble);
    }
    return this.sentIds;
  }
}
