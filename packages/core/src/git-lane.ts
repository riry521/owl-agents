/**
 * Serializes asynchronous operations per key. Git operations that share a
 * repository (its index, lock files, refs and worktree registry) run one at a
 * time on the lane of that repository's canonical path, while operations on
 * different repositories still run in parallel.
 */
export class GitLanes {
  private readonly lanes = new Map<string, Promise<void>>();

  /**
   * Run `operation` after every operation queued earlier on `key` has
   * settled. A failure rejects only this caller; the lane keeps running.
   */
  public run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.lanes.set(key, tail);
    void tail.then(() => {
      if (this.lanes.get(key) === tail) this.lanes.delete(key);
    });
    return result;
  }

  /** Whether any operation is queued or running on `key`. */
  public busy(key: string): boolean {
    return this.lanes.has(key);
  }
}
