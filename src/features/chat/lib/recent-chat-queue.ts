/** Defer recent-chat persistence until the session's queued deltas are applied. */
export function createRecentChatQueue(record: (sessionId: string) => void, schedule: () => void) {
  const pending = new Set<string>();
  return {
    note(sessionId: string) {
      pending.add(sessionId);
      schedule();
    },
    drain() {
      const sessions = [...pending];
      pending.clear();
      for (const sessionId of sessions) record(sessionId);
    },
  };
}
