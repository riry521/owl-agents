import { compareText } from "../context-canonical.js";
import type { MemoryIndex } from "./memory-index.js";
import { defuseTags, EXTERNAL_DATA_ATTR } from "./memory-injector.js";
import type { MemorySearch } from "./memory-search.js";
import type { MemoryLogger } from "./memory-types.js";

/** Candidates fetched before the similarity cut; the settings limit (at most 3) applies after it. */
const CANDIDATES = 10;

export interface RecallItem {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  /** `YYYY-MM-DD` the clipping was fetched. */
  readonly retrieved: string;
  readonly similarity: number;
}

export interface ResearchRecallOptions {
  readonly search: Pick<MemorySearch, "search">;
  readonly index: Pick<MemoryIndex, "db">;
  /** Read at every call, so a settings change needs no restart. */
  readonly settings: () => { readonly limit: number; readonly min_similarity: number };
  readonly logger?: MemoryLogger;
}

/** Finds the research clippings a statement is strongly about (design §8). Never throws. */
export class ResearchRecall {
  public constructor(private readonly options: ResearchRecallOptions) {}

  public async recall(query: string, exclude_ids: readonly string[] = []): Promise<RecallItem[]> {
    const text = query.trim();
    if (!text) return [];
    try {
      const { limit, min_similarity } = this.options.settings();
      const result = await this.options.search.search({ query: text, page_types: ["clipping"], include_raw: true, template_valid_only: true, limit: CANDIDATES, exclude_ids });
      // Without usable vectors only FTS ranks are left, and those say nothing about how strong a match is.
      if (result.stale || result.mode !== "hybrid") return [];
      const strong = result.hits
        .filter((hit) => hit.vec_similarity !== null && hit.vec_similarity >= min_similarity)
        // Rounded so float noise cannot reorder hits; ties fall back to the note id.
        .sort((a, b) => Math.round((b.vec_similarity ?? 0) * 100) - Math.round((a.vec_similarity ?? 0) * 100) || compareText(a.row.id, b.row.id))
        .slice(0, limit);
      return strong.map((hit) => {
        const retrieved = this.options.index.db().prepare("SELECT retrieved_at FROM notes WHERE rowid = ?").get(hit.rowid) as { retrieved_at: string | null } | undefined;
        return {
          id: hit.row.id, path: hit.row.path, title: hit.row.title, summary: hit.row.summary,
          retrieved: (retrieved?.retrieved_at ?? hit.row.created ?? "").slice(0, 10), similarity: hit.vec_similarity ?? 0,
        };
      });
    } catch (error) {
      this.options.logger?.warn("research recall failed", error);
      return [];
    }
  }
}

/** One line per clipping, titles and summaries only (no body); null when there is nothing to say. */
export function renderRecall(items: readonly RecallItem[]): string | null {
  if (items.length === 0) return null;
  const lines = items.map((i) => `前に調べた資料: [[${defuseTags(i.title)}]] — ${defuseTags(i.summary)}${i.retrieved ? `（${i.retrieved}）` : ""}`);
  return `<owl-research-recall ${EXTERNAL_DATA_ATTR}>\n${lines.join("\n")}\n</owl-research-recall>`;
}
