import { StringDecoder } from "node:string_decoder";

const TAIL_BYTES = 64 * 1024;
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export class ClaudeStreamReader {
  private pending = "";
  private readonly decoder = new StringDecoder("utf8");
  private tail = "";
  private result: string | null = null;
  private discarding = false;
  public constructor(private readonly onProgress: () => void) {}
  public push(chunk: string | Buffer): void {
    let text = Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : chunk;
    if (this.discarding) {
      const end = text.indexOf("\n");
      if (end < 0) return;
      this.discarding = false;
      text = text.slice(end + 1);
    }
    this.pending += text;
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      this.accept(line);
      newline = this.pending.indexOf("\n");
    }
    if (this.pending.length > MAX_LINE_CHARS) {
      this.pending = "";
      this.discarding = true;
      this.appendTail("[oversized line discarded]");
    }
  }
  private accept(line: string): void {
    if (!line) return;
    let event: Record<string, unknown>;
    try { event = record(JSON.parse(line)); } catch { this.appendTail(line); return; }
    if (event.type === "error") { this.result = line; return; }
    if (event.type === "result") { this.result = line; this.onProgress(); return; }
    this.appendTail(line);
    if (event.type === "rate_limit_event" || (event.type === "system" && event.subtype === "api_retry") || !event.type) return;
    this.onProgress();
  }
  private appendTail(line: string): void {
    const bytes = Buffer.from(`${this.tail}${line}\n`);
    let start = Math.max(0, bytes.length - TAIL_BYTES);
    while (start < bytes.length && (bytes[start] & 0xC0) === 0x80) start += 1;
    this.tail = bytes.subarray(start).toString("utf8");
  }
  public output(): string {
    this.pending += this.decoder.end();
    if (this.pending.trim()) this.accept(this.pending.trim());
    this.pending = "";
    return this.result ?? this.tail;
  }
  public retainedBytes(): number { return Buffer.byteLength(this.result ?? "") + Buffer.byteLength(this.tail); }
}
