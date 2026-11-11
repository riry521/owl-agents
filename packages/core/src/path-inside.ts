import { isAbsolute, relative, resolve, sep } from "node:path";

/** True when `candidate` is under `base`. `includeSelf` decides whether `base` itself counts as inside. */
export function isPathInside(base: string, candidate: string, includeSelf: boolean): boolean {
  const rel = relative(resolve(base), resolve(candidate));
  if (rel === "") return includeSelf;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
