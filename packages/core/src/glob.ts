import { minimatch } from "minimatch";

// Same options node:path's matchesGlob passes to its bundled minimatch (Node 22), plus dot:true so that `*`, `**` and `?`
// also match segments starting with "." (.github/). matchesGlob has no way to set dot, and rewriting paths or patterns around
// it was rejected: it was exponential or drifted from minimatch on ranges and boundaries.
const OPTIONS = {
  dot: true,
  nocase: process.platform === "darwin" || process.platform === "win32",
  windowsPathsNoEscape: true,
  nonegate: true,
  nocomment: true,
  optimizationLevel: 2,
  platform: process.platform,
  nocaseMagicOnly: true,
} as const;

export const matchesGlobWithDots = (path: string, pattern: string): boolean => minimatch(path, pattern, OPTIONS);
