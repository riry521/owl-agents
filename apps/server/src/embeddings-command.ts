import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ChildEmbedder, MEMORY_INDEX_FILE, downloadModel, embedIndexFile, embeddingsEnabledSetting, enableIfUnset, isValidModelName, loadEmbedderConfig,
} from "@owl/core";
import type { Embedder, EmbedderConfig } from "@owl/core";
import { cliText } from "./cli-language.js";

export interface EmbeddingsCommandInput {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Raw text (no newline added) for the one-line progress; used only when isTTY. */
  write?: (text: string) => void;
  /** Progress is overwritten on one line only on a terminal. */
  isTTY?: boolean;
  fetch?: typeof fetch;
  createEmbedder?: (config: EmbedderConfig) => Embedder;
  /** Whether a server is running, to tell the user a restart is needed. */
  serverRunning?: () => Promise<boolean>;
}

/** True only when the environment or memory-embedder.json says false; an unset value is not a refusal. */
function explicitlyOff(dataDir: string, env: NodeJS.ProcessEnv): boolean {
  let fileEnabled: unknown;
  try { fileEnabled = (JSON.parse(readFileSync(join(dataDir, "memory-embedder.json"), "utf8")) as { enabled?: unknown }).enabled; } catch { /* no usable file: unset */ }
  return embeddingsEnabledSetting(env, fileEnabled) === false;
}

/** Downloads the model, enables embeddings when unset, and embeds the pending notes of an existing index. Returns the exit code. */
export async function runEmbeddingsCommand(input: EmbeddingsCommandInput): Promise<number> {
  const { dataDir, env, out, err } = input;
  // out adds a newline per call, so the CLI passes write for in-place progress; without it progress still goes to out.
  const progress = input.write ?? out;
  const config = loadEmbedderConfig(dataDir, env);
  if (explicitlyOff(dataDir, env)) {
    out(cliText("埋め込みは設定で無効になっているので、何もしません。", "Embeddings are disabled in the settings, so nothing was done."));
    return 0;
  }
  if (!isValidModelName(config.model)) {
    err(cliText(`モデル名は org/name の形で指定してください: ${config.model}`, `The model name must look like org/name: ${config.model}`));
    return 2;
  }
  const started = Date.now();
  let bytes = 0;
  try {
    const result = await downloadModel({ model: config.model, modelsDir: config.modelsDirs[0]!, host: config.modelHost, fetch: input.fetch, onProgress: (file) => out(`  ${file}`) });
    bytes = result.bytes;
  } catch (error) {
    err((error as Error).message);
    return 1;
  }
  let enabledNow: string;
  try { enabledNow = await enableIfUnset(dataDir, env); } catch (error) {
    err((error as Error).message);
    return 1;
  }
  out(cliText(`モデル ${config.model} を用意しました（ダウンロード ${(bytes / 1048576).toFixed(1)} MB）。`, `Model ${config.model} is ready (downloaded ${(bytes / 1048576).toFixed(1)} MB).`));

  const indexPath = join(dataDir, MEMORY_INDEX_FILE);
  if (!existsSync(indexPath)) {
    out(cliText("索引はまだありません。サーバーの起動時に索引を作り、そのあと裏でベクトルも作ります。", "There is no index yet. The server builds it on start, then builds the vectors in the background."));
  } else {
    const embedder = (input.createEmbedder ?? ((c) => new ChildEmbedder(c)))({ ...config, enabled: true });
    try {
      const result = await embedIndexFile({
        indexPath, embedder, profile: config.profile, pageTypes: config.pageTypes,
        meta: { rrf_w_fts: String(config.weights.fts), rrf_w_vec: String(config.weights.vec) },
        onProgress: (done, total) => {
          if (input.isTTY) progress(`\r${cliText("埋め込み", "Embedding")} ${done} / ${total}`);
        },
      });
      if (input.isTTY) progress("\n");
      if (result.status === "schema_mismatch") {
        err(cliText("索引の版が違います。サーバーを起動して索引を作り直してから、もう一度実行してください。", "The index version differs. Start the server to rebuild the index, then run this again."));
        return 1;
      }
      if (result.status === "done") {
        out(cliText(`${result.embedded} 件を埋め込みました（${((Date.now() - started) / 1000).toFixed(1)} 秒）。`, `Embedded ${result.embedded} notes (${((Date.now() - started) / 1000).toFixed(1)} s).`));
      }
    } catch (error) {
      err((error as Error).message);
      return 1;
    } finally {
      await embedder.stop();
    }
  }
  if (enabledNow === "written" && input.serverRunning && await input.serverRunning()) {
    out(cliText("サーバーの再起動（owl restart）で検索に反映されます。", "Restart the server (owl restart) to apply this to search."));
  }
  return 0;
}
