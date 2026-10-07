import { createHash } from "node:crypto";
import type { PromptFingerprint } from "@owl/shared";
import { ROLE_INPUT_LAYERS, splitRenderedPrompt, type RoleInputLayer } from "./role-contract";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Hash the header and each cache layer of a rendered role prompt. Null when the
 * prompt has no Input section. A layer with no slot hashes to null.
 */
export function promptFingerprint(prompt: string): PromptFingerprint | null {
  const split = splitRenderedPrompt(prompt);
  if (!split) return null;
  const layerHash = (layer: RoleInputLayer): string | null => {
    const texts = split.slots.filter((slot) => (ROLE_INPUT_LAYERS[slot.name] ?? "dynamic") === layer).map((slot) => slot.text);
    return texts.length > 0 ? sha256(texts.join("\n\n")) : null;
  };
  return { header: sha256(split.header), project: layerHash("project"), task: layerHash("task"), dynamic: layerHash("dynamic") };
}
