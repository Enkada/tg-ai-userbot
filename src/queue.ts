/**
 * Per-chat serialization. Every stateful action for a chat — handling an incoming
 * message, or the proactive scheduler deciding to reach out — runs through the chat's
 * single promise chain, so they execute strictly one at a time in submission order.
 *
 * This keeps the stored history cleanly alternating (user → assistant → …) and, crucially,
 * prevents a proactive send from racing an in-flight user reply: the scheduler's evaluation
 * and any message it sends always run between user turns, never overlapping one. Without it,
 * two concurrent tasks could interleave LLM calls and write adjacent same-role rows.
 */
const chatQueues = new Map<number, Promise<void>>();

/** Appends `task` to a chat's queue, running it after all previously enqueued tasks settle. */
export function enqueue(chatId: number, task: () => Promise<void>): void {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  // Run the next task regardless of whether the previous one settled or threw, so one
  // failure never wedges the chat. Tasks are expected to handle their own errors.
  const next = prev.then(task, task);
  chatQueues.set(chatId, next);
  next.finally(() => {
    // Drop the entry once the chain has fully drained, so idle chats don't leak memory.
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
  });
}
