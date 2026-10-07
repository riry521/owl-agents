// Stand-in for dist/memory/embedder-child.js: same IPC protocol, keyword-group vectors, failure modes chosen by FAKE_MODE.
const fs = require("node:fs");

const GROUPS = [["apple", "fruit"], ["car", "vehicle"], ["tax", "money"]];
const vec = (text) => {
  const v = [...GROUPS.map((g) => (g.some((w) => text.toLowerCase().includes(w)) ? 1 : 0)), 0.1];
  const norm = Math.hypot(...v);
  return Float32Array.from(v, (x) => x / norm);
};

process.on("message", (m) => {
  if (m.op === "init") {
    if (process.env.FAKE_MODE === "exit-on-init") process.exit(3);
    process.send({ op: "ready", dim: GROUPS.length + 1 });
    return;
  }
  const dieOnce = process.env.FAKE_MODE === "die-once" && !fs.existsSync(process.env.FAKE_MARKER);
  if (process.env.FAKE_MODE === "die-always" || dieOnce) {
    if (dieOnce) fs.writeFileSync(process.env.FAKE_MARKER, "x");
    process.exit(1);
  }
  process.send({ id: m.id, vectors: m.texts.map(vec) });
});
process.on("disconnect", () => process.exit(0));
