import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { parse } from "smol-toml";

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function main(args: string[]): Promise<number> {
  const [file, limitText, ...extra] = args;
  if (!file || !limitText || extra.length > 0) return 2;
  const maxReadBytes = Number(limitText);
  if (!/^\d+$/u.test(limitText) || !Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) return 2;
  if (isAbsolute(file) || win32.isAbsolute(file) || file.split(/[\\/]/u).includes("..")) return 2;

  const root = await realpath(process.cwd());
  const target = resolve(root, file);
  if (!inside(root, target)) return 2;

  let handle;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) return 2;
    const resolvedTarget = await realpath(target);
    if (!inside(root, resolvedTarget)) return 2;
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile()) return 2;
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= maxReadBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxReadBytes + 1 - bytesRead));
      const result = await handle.read(chunk, 0, chunk.length, bytesRead);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxReadBytes) return 2;
    try {
      const contents = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytesRead));
      parse(contents, { integersAsBigInt: true });
    } catch {
      process.stderr.write(`${file}: TOML syntax error\n`);
      return 1;
    }
    return 0;
  } catch {
    process.stderr.write(`${file}: file read error\n`);
    return 2;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => {
  process.stderr.write("TOML checker error\n");
  process.exitCode = 2;
});
