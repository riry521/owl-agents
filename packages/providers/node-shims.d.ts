declare module "node:crypto" {
  interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:fs" {
  export interface Stats {
    readonly mode: number;
    isFile(): boolean;
  }
  export function readFileSync(path: string): Uint8Array;
  export function realpathSync(path: string): string;
  export function statSync(path: string): Stats;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:path" {
  export const sep: string;
  export function isAbsolute(path: string): boolean;
}

declare module "node:child_process" {
  export function spawn(
    file: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: Readonly<Record<string, string>>;
      shell: false;
      stdio: ["pipe", "pipe", "pipe"];
      detached?: boolean;
    },
  ): unknown;
}

declare module "node:process" {
  export function kill(pid: number, signal?: string): void;
}
