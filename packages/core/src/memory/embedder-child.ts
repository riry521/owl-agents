// Child process of ChildEmbedder: loads the ONNX model and answers `{ id, texts }` with `{ id, vectors }`.
// onnxruntime is why this is not done in the server (+0.75GB RSS), so it is only imported here, dynamically.
type Extractor = (texts: string[], options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;
type Transformers = { env: { allowRemoteModels: boolean; localModelPath: string }; pipeline(task: string, model: string, options: object): Promise<unknown> };
type Message = { op?: string; id?: number; texts?: string[]; maxTokens?: number; model: string; modelsDir: string; pooling: string };

type Tokenizer = { model_max_length?: number };
let extractor: Extractor | null = null;
let tokenizer: Tokenizer | null = null;
let modelMax: number | undefined;
let pooling = "mean";
let dim = 0;

async function init(message: Message): Promise<void> {
  try {
    // Non-literal specifier: tsc must not resolve it, so the build passes before `pnpm install` has added the dependency.
    const specifier = "@huggingface/transformers";
    const tf = (await import(specifier)) as Transformers;
    tf.env.allowRemoteModels = false;
    tf.env.localModelPath = message.modelsDir;
    const pipe = await tf.pipeline("feature-extraction", message.model, { dtype: "q8", session_options: { enableCpuMemArena: false, enableMemPattern: false } });
    tokenizer = (pipe as unknown as { tokenizer: Tokenizer }).tokenizer;
    modelMax = tokenizer.model_max_length;
    extractor = (texts, options) => (pipe as unknown as Extractor)(texts, options);
    dim = (await extractor(["probe"], { pooling, normalize: true })).dims[1] ?? 0;
    process.send?.({ op: "ready", dim });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const missing = err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND";
    process.send?.({ op: "init_error", code: missing ? "missing" : "failed", error: missing ? `${err.message} (埋め込みを使うには pnpm install が必要)` : err.message });
  }
}

process.on("message", (message: Message) => {
  if (message.op === "init") { pooling = message.pooling; void init(message); return; }
  const { id, texts, maxTokens } = message;
  // model_max_length is a getter on the prototype; shadow it per request (0 restores the model's own limit).
  if (tokenizer) Object.defineProperty(tokenizer, "model_max_length", { value: maxTokens ? Math.min(maxTokens, modelMax ?? maxTokens) : modelMax, configurable: true });
  if (!extractor || !texts) { process.send?.({ id, error: "embedder not ready" }); return; }
  extractor(texts, { pooling, normalize: true }).then(
    (out) => process.send?.({ id, vectors: texts.map((_, i) => out.data.slice(i * dim, (i + 1) * dim)) }),
    (error: Error) => process.send?.({ id, error: error.message }),
  );
});

process.on("disconnect", () => process.exit(0));
