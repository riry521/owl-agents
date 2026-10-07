/**
 * Poll read() (sync or async) until it returns a truthy value and return that value.
 * @template T
 * @param {() => T | Promise<T>} read
 * @param {{ timeoutMs?: number, intervalMs?: number, message?: string }} [options]
 * @returns {Promise<T>}
 */
export async function waitFor(read, { timeoutMs = 10_000, intervalMs = 20, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
