/** Polls a controlled-bot sample without turning transient post-restart receipts into startup errors. */
export async function waitForPrivateServerSample({
  delay,
  isTransientError,
  now = Date.now,
  sample,
  tickDeadline,
  timeoutMs = 30_000,
}) {
  const started = now();
  let previousTick = -1;
  let sampled = false;
  while (now() - started < timeoutMs) {
    try {
      const result = await sample();
      sampled = true;
      if (result.tick > previousTick && result.tick >= tickDeadline) {
        return Object.freeze({ kind: "sample", result });
      }
      previousTick = result.tick;
    } catch (error) {
      if (!isTransientError(error)) throw error;
    }
    await delay(250);
  }
  return Object.freeze({ kind: sampled ? "deadline" : "not-ready" });
}
