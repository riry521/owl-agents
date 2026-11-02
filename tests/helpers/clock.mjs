/** Manual clock for the LibrarianSchedulerClock interface: timers fire in order as `advanceTo` moves time. */
export class FakeClock {
  constructor(now) {
    this.value = new Date(now);
    this.timers = new Map();
  }
  now() { return new Date(this.value); }
  setTimeout(callback, ms) {
    const handle = {};
    this.timers.set(handle, { callback, at: this.value.getTime() + ms });
    return handle;
  }
  clearTimeout(handle) { this.timers.delete(handle); }
  async advanceTo(now) {
    const target = new Date(now).getTime();
    for (;;) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.timers.delete(next[0]);
      this.value = new Date(next[1].at);
      next[1].callback();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }
    this.value = new Date(target);
  }
}
