import type { PageRouter } from "./page-router.js";

/** "〜しない" (a verb ending in ない) / "〜に気をつける" read as a pitfall; any other explicit memory is a decision. */
const PITFALL_FORM = /(?:ない|に気をつける)(?:こと)?[。.!！]*$/u;

/** `projectId` is the scope; with null the memory goes to common/. Returns the page path. */
export async function routeExplicitMemory(router: Pick<PageRouter, "route">, text: string, projectId: string | null): Promise<string> {
  const result = await router.route({
    kind: PITFALL_FORM.test(text.trim()) ? "pitfall" : "decision", text, project_id: projectId,
    source: { work_number: null, work_id: null, actor: "advisor" },
  });
  if (result.status === "deferred") {
    throw Object.assign(new Error("The knowledge storage is unavailable."), { code: "storage_unavailable" });
  }
  if (result.status === "rejected") throw new Error(`explicit_memory_rejected: ${result.reason ?? ""}`);
  return result.page ?? "";
}
