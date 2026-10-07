import { writeFile } from "node:fs/promises";

process.on("SIGTERM", () => {});
await writeFile(process.env.READY_FILE, "ready", "utf8");
setInterval(() => {}, 1000);
