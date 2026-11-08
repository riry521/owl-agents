import type { SessionActivity } from "./types";

/**
 * Folds provider lines into one SessionActivity and reports it only when it
 * changes. Display only: a throwing callback never reaches the session.
 */
export class SessionActivityTracker {
  private turnActive = false;
  private readonly openTools = new Map<string, { kind: "tool" | "subagent"; name: string }>();
  private backgroundTasks = new Set<string>();
  private last: SessionActivity | null = null;

  public constructor(private readonly onChange: ((activity: SessionActivity) => void) | undefined) {}

  public turnStarted(): void {
    this.turnActive = true;
    this.publish();
  }

  /** Ends the foreground, including any tool whose result never arrived. */
  public turnEnded(): void {
    this.turnActive = false;
    this.openTools.clear();
    this.publish();
  }

  public toolStarted(id: string, kind: "tool" | "subagent", name: string): void {
    this.turnActive = true;
    // Re-insert so the most recently opened tool is last.
    this.openTools.delete(id);
    this.openTools.set(id, { kind, name });
    this.publish();
  }

  public toolEnded(id: string): void {
    this.openTools.delete(id);
    this.publish();
  }

  /** Replaces the whole set; the CLI lists every running task each time. */
  public backgroundChanged(taskIds: readonly string[]): void {
    this.backgroundTasks = new Set(taskIds);
    this.publish();
  }

  public backgroundEnded(taskId: string): void {
    this.backgroundTasks.delete(taskId);
    this.publish();
  }

  public processEnded(): void {
    this.turnActive = false;
    this.openTools.clear();
    this.backgroundTasks.clear();
    this.publish();
  }

  private current(): SessionActivity {
    const innermost = [...this.openTools.values()].at(-1);
    if (innermost) {
      return {
        state: innermost.kind,
        tool_name: innermost.kind === "tool" ? innermost.name : null,
        background_count: this.backgroundTasks.size,
      };
    }
    return { state: this.turnActive ? "thinking" : null, tool_name: null, background_count: this.backgroundTasks.size };
  }

  private publish(): void {
    if (!this.onChange) return;
    const next = this.current();
    const prev = this.last;
    if (prev && prev.state === next.state && prev.tool_name === next.tool_name && prev.background_count === next.background_count) return;
    this.last = next;
    try {
      this.onChange(next);
    } catch (error) {
      console.warn("[session-activity] The activity handler failed.", error);
    }
  }
}
