import { writeFile } from "node:fs/promises";

await writeFile(process.env.DUMP_FILE, JSON.stringify(process.env), "utf8");
console.log("ready");
console.error("diagnostic");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
