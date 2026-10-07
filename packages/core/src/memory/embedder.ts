import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EmbedderState = "disabled" | "unavailable" | "missing" | "idle" | "starting" | "ready" | "failed";

export interface EmbedderHealth {
  readonly model: string | null; readonly model_path: string | null; readonly dim: number | null; readonly state: EmbedderState;
  readonly last_error: string | null; readonly retry_after: string | null;
  readonly pid: number | null; readonly started_at: string | null; readonly pending_passages: number;
  readonly warning: string | null;
}

export interface Embedder {
  readonly model: string | null;
  health(): EmbedderHealth;
  isReady(): boolean;
  warmup(): void;
  embed(kind: "query" | "passage", texts: readonly string[], options?: { timeoutMs?: number; maxTokens?: number }): Promise<Float32Array[]>;
  stop(): Promise<void>;
}

/** How notes are chunked, which extra lists join the RRF, and how queries are cut (chosen on the dev split; recorded in index meta `profile`). */
export interface RetrievalProfile {
  /** Max body characters per chunk. */
  readonly chunkChars: number;
  /** Body chunks kept per note; long notes otherwise get more chances to win the nearest-chunk race. */
  readonly maxChunks: number;
  /** Put title and summary at the head of every chunk, not only the first. */
  readonly prefix: boolean;
  /** RRF weight of the list built from a title+summary-only vector per note (0 = off). */
  readonly headVec: number;
  /** RRF weight of the list built from FTS over title/summary/tags only (0 = off). */
  readonly ftsHead: number;
  /** Cut Japanese query segments at hiragana runs (particles, verb endings) before making trigrams. */
  readonly content: boolean;
  /** Characters of the query sent to the embedder; pasted logs and stack traces otherwise dominate the vector. */
  readonly queryChars: number;
  /** Candidates each list contributes to RRF. */
  readonly ftsTop: number;
  /** Tokens per text the model reads (0 = the model's own limit). Attention memory grows with length, so this bounds the child's peak RSS. */
  readonly maxTokens: number;
}

export interface EmbedderConfig {
  /** Embeddings are opt-in because the optional runtime can use substantial memory. */
  readonly enabled?: boolean;
  /** Hugging Face model id; the files live in `<modelsDir>/<model>`. */
  readonly model: string;
  /** Searched in order; the first directory that holds the model wins. */
  readonly modelsDirs: readonly string[];
  /** The child is stopped after this long without a request (design §4.3: 10 minutes). */
  readonly idleMs: number;
  /** After a second consecutive failure the next attempt waits this long (design §16). */
  readonly retryMs: number;
  readonly requestTimeoutMs: number;
  /** Fusion weights chosen on the dev split (see docs/designs … §4.3 and meta rrf_w_*). */
  readonly weights: { readonly fts: number; readonly vec: number };
  readonly profile: RetrievalProfile;
  /** Test hook: a script that speaks the embedder-child protocol. */
  readonly childPath?: string;
  /** Test hook for verifying whether the child is started. */
  readonly forkChild?: typeof fork;
}

/** Default chosen from an offline embedding-model comparison (see `scripts/memory-eval.mjs`). */
export const DEFAULT_EMBEDDER_CONFIG: EmbedderConfig = {
  enabled: false,
  model: "Xenova/multilingual-e5-small",
  modelsDirs: [],
  idleMs: 10 * 60_000,
  retryMs: 10 * 60_000,
  requestTimeoutMs: 120_000,
  weights: { fts: 1, vec: 1.5 },
  profile: { chunkChars: 1500, maxChunks: 20, prefix: true, headVec: 1, ftsHead: 0.5, content: false, queryChars: 60, ftsTop: 20, maxTokens: 384 },
};

const disabledWarning = "埋め込みは設定で無効です。利用するには memory_embeddings.enabled を true にしてください（OWL_MEMORY_EMBEDDINGS_ENABLED=true でも設定できます）。";

export function embeddingUnavailableWarning(detail?: string): string {
  return `埋め込みを利用できません${detail ? `（${detail}）` : ""}。有効化するには optional 依存を除外せず pnpm install を実行し、node scripts/memory-models.mjs pull Xenova/multilingual-e5-small を実行してから、memory_embeddings.enabled を true に設定してください。`;
}

function missingModelWarning(model: string, dirs: readonly string[]): string {
  return `モデル ${model} が見つかりません（検索先: ${dirs.join(", ")}）。自動取得は行いません。node scripts/memory-models.mjs pull ${model} を実行してください。`;
}

/** `<dataDir>/models` (design §4.3), then `~/.owl/models`, which is outside data/. `memory-embedder.json` and OWL_MEMORY_* override. */
export function loadEmbedderConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): EmbedderConfig {
  let file: Partial<EmbedderConfig> = {};
  try { file = JSON.parse(readFileSync(join(dataDir, "memory-embedder.json"), "utf8")) as Partial<EmbedderConfig>; } catch (error) {
    // The file is optional, so a missing one is silent; an unreadable or malformed one means the settings are ignored.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[owl-core] Could not read memory-embedder.json; using the default embedder settings.", error);
  }
  const num = (v: string | undefined): number | undefined => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const envEnabled = ["true", "1"].includes(env.OWL_MEMORY_EMBEDDINGS_ENABLED ?? "") ? true : ["false", "0"].includes(env.OWL_MEMORY_EMBEDDINGS_ENABLED ?? "") ? false : undefined;
  const config = { ...DEFAULT_EMBEDDER_CONFIG, ...file, profile: { ...DEFAULT_EMBEDDER_CONFIG.profile, ...file.profile } };
  return {
    ...config,
    enabled: envEnabled ?? (typeof file.enabled === "boolean" ? file.enabled : false),
    model: env.OWL_MEMORY_EMBED_MODEL ?? config.model,
    idleMs: num(env.OWL_MEMORY_EMBED_IDLE_MS) ?? config.idleMs,
    modelsDirs: [...(env.OWL_MEMORY_MODELS_DIR ? [env.OWL_MEMORY_MODELS_DIR] : file.modelsDirs ?? []), join(dataDir, "models"), join(homedir(), ".owl", "models")],
  };
}

interface ModelSpec { readonly query: string; readonly passage: string; readonly pooling: "mean" | "last_token" }

const SPECS: readonly (readonly [RegExp, ModelSpec])[] = [
  [/e5/iu, { query: "query: ", passage: "passage: ", pooling: "mean" }],
  [/ruri/iu, { query: "検索クエリ: ", passage: "検索文書: ", pooling: "mean" }],
  [/qwen3-embedding/iu, { query: "Instruct: Given a search query, retrieve the relevant notes\nQuery: ", passage: "", pooling: "last_token" }],
];

export function modelSpec(model: string): ModelSpec {
  return SPECS.find(([re]) => re.test(model))?.[1] ?? { query: "", passage: "", pooling: "mean" };
}

export const embeddingText = (model: string, kind: "query" | "passage", text: string): string => modelSpec(model)[kind] + text;

/** No embeddings: always disabled, search answers from FTS only. */
export class NullEmbedder implements Embedder {
  public readonly model = null;
  private readonly reason: string;

  public constructor(reason: string) {
    this.reason = reason;
  }

  public health(): EmbedderHealth {
    return { model: null, model_path: null, dim: null, state: "disabled", last_error: this.reason, retry_after: null, pid: null, started_at: null, pending_passages: 0, warning: this.reason };
  }

  public isReady(): boolean { return false; }
  public warmup(): void { /* nothing to start */ }
  public embed(): Promise<Float32Array[]> { return Promise.reject(new Error(this.reason)); }
  public stop(): Promise<void> { return Promise.resolve(); }
}

type Reply = { id?: number; op?: "ready" | "init_error"; dim?: number; code?: "missing" | "failed"; vectors?: Float32Array[]; error?: string };
type Waiter = { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/**
 * Computes embeddings in a child process (onnxruntime adds ~0.75GB RSS, which must not land in the server).
 * Started by the first embed, stopped after `idleMs` of silence, restarted once after a crash.
 */
export class ChildEmbedder implements Embedder {
  public readonly model: string | null;
  private readonly config: EmbedderConfig;
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private state: EmbedderState;
  private dim: number | null = null;
  private lastError: string | null = null;
  private startedAt: string | null = null;
  private retryAt = 0;
  private failures = 0;
  private inFlight = 0;
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly waiting = new Map<number, Waiter>();

  public constructor(config: EmbedderConfig) {
    this.config = config;
    this.model = config.enabled === true ? config.model : null;
    this.state = config.enabled === true ? "idle" : "disabled";
    this.lastError = config.enabled === true ? null : disabledWarning;
  }

  public health(): EmbedderHealth {
    const modelDir = this.model ? this.modelDir() : null;
    const missing = this.config.enabled === true && this.state === "idle" && !modelDir;
    const state = missing ? "missing" : this.state;
    const lastError = missing ? `model ${this.config.model} not found in ${this.config.modelsDirs.join(", ")}` : this.lastError;
    return {
      model: this.model, model_path: modelDir && this.model ? join(modelDir, this.model) : null, dim: this.dim, state, last_error: lastError,
      retry_after: this.retryAt > Date.now() ? new Date(this.retryAt).toISOString() : null,
      pid: this.child?.pid ?? null, started_at: this.startedAt, pending_passages: this.inFlight, warning: this.warning(state, lastError),
    };
  }

  private warning(state = this.state, lastError = this.lastError): string | null {
    if (this.config.enabled !== true) return disabledWarning;
    if (state === "missing") return missingModelWarning(this.config.model, this.config.modelsDirs);
    if (state === "failed" || state === "unavailable") return embeddingUnavailableWarning(lastError ?? undefined);
    return null;
  }

  public isReady(): boolean { return this.state === "ready"; }

  public warmup(): void {
    // Why not log: start() records the failure in state/last_error, which health() reports.
    this.start().catch(() => undefined);
  }

  private modelDir(): string | null {
    return this.config.modelsDirs.find((dir) => existsSync(join(dir, this.config.model, "config.json"))) ?? null;
  }

  private start(): Promise<void> {
    if (this.config.enabled !== true) return Promise.reject(new Error(disabledWarning));
    if (this.ready && this.child) return this.ready;
    if (this.retryAt > Date.now()) return Promise.reject(new Error(this.lastError ?? "embedder is waiting to retry"));
    const dir = this.modelDir();
    if (!dir) return this.fail("missing", `model ${this.config.model} not found in ${this.config.modelsDirs.join(", ")}`, false);
    this.state = "starting";
    const child = (this.config.forkChild ?? fork)(this.config.childPath ?? join(__dirname, "embedder-child.js"), [], { serialization: "advanced", stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: [] });
    this.child = child;
    child.on("message", (reply: Reply) => this.onMessage(reply));
    child.on("error", (error) => this.onExit(child, error.message));
    child.on("exit", (code, signal) => this.onExit(child, `embedder-child exited (${signal ?? code})`));
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, this.config.requestTimeoutMs);
      this.waiting.set(0, {
        timer, reject,
        resolve: (reply) => {
          if (reply.op === "ready") { this.dim = reply.dim ?? null; this.state = "ready"; this.startedAt = new Date().toISOString(); resolve(); }
          else this.fail(reply.code === "missing" ? "unavailable" : "failed", reply.error ?? "embedder init failed", true).catch(reject);
        },
      });
    });
    this.ready = ready;
    // Why not log: callers awaiting `ready` get the rejection; this only marks it handled.
    ready.catch(() => undefined);
    child.send({ op: "init", model: this.config.model, modelsDir: dir, pooling: modelSpec(this.config.model).pooling });
    return ready;
  }

  private fail(state: "missing" | "failed" | "unavailable", message: string, countRetry: boolean): Promise<never> {
    this.state = state;
    this.lastError = message;
    if (countRetry) {
      // One immediate retry on the next search; after a second failure in a row wait `retryMs`.
      this.failures += 1;
      if (this.failures >= 2) this.retryAt = Date.now() + this.config.retryMs;
    }
    this.ready = null;
    this.dim = null;
    this.startedAt = null;
    const child = this.child;
    this.child = null;
    child?.removeAllListeners("exit");
    child?.kill("SIGKILL");
    this.rejectAll(new Error(message));
    return Promise.reject(new Error(message));
  }

  private rejectAll(error: Error): void {
    for (const [id, waiter] of this.waiting) { clearTimeout(waiter.timer); waiter.reject(error); this.waiting.delete(id); }
  }

  private onMessage(reply: Reply): void {
    const key = reply.op ? 0 : reply.id ?? -1;
    const waiter = this.waiting.get(key);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiting.delete(key);
    waiter.resolve(reply);
  }

  private onExit(child: ChildProcess, message: string): void {
    if (this.child !== child) return;
    this.fail("failed", message, true).catch((error: unknown) => console.error("[owl-core] Embedder could not record its exit", error));
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.stop(); }, this.config.idleMs);
    this.idleTimer.unref();
  }

  public async embed(kind: "query" | "passage", texts: readonly string[], options?: { timeoutMs?: number; maxTokens?: number }): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    this.inFlight += texts.length;
    try {
      await this.start();
      const child = this.child as ChildProcess;
      const id = this.nextId++;
      const reply = await new Promise<Reply>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); }, options?.timeoutMs ?? this.config.requestTimeoutMs);
        this.waiting.set(id, { resolve, reject, timer });
        child.send({ id, maxTokens: options?.maxTokens ?? 0, texts: texts.map((t) => embeddingText(this.config.model, kind, t)) });
      });
      if (reply.error || !reply.vectors) throw new Error(reply.error ?? "embedder returned no vectors");
      this.failures = 0;
      this.touchIdle();
      return reply.vectors;
    } finally {
      this.inFlight -= texts.length;
    }
  }

  /** Idle stop and shutdown. Not a failure: the next embed starts a fresh child. */
  public async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.ready = null;
    this.state = "idle";
    this.startedAt = null;
    child.removeAllListeners("exit");
    this.rejectAll(new Error("embedder stopped"));
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
  }
}

export function createDefaultEmbedder(): Embedder {
  return new NullEmbedder(disabledWarning);
}
