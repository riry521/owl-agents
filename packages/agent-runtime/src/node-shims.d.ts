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
