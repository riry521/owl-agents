import { chmod, cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CREATED_BY_WORK_CONFIG_KEY } from "./repository-inspection.js";

export const WORK_GIT_TEMPLATES_DIRNAME = "git-templates";

export interface WorkGitTemplateDependencies {
  userTemplateDir(): Promise<string | null>;
  setTemplateConfig(file: string, key: string, value: string): Promise<void>;
}

export async function prepareWorkGitTemplate(
  deps: WorkGitTemplateDependencies,
  input: { readonly dataDir: string; readonly agentRunId: string; readonly workId: string },
): Promise<string> {
  const templateDir = join(input.dataDir, WORK_GIT_TEMPLATES_DIRNAME, input.agentRunId);
  await mkdir(templateDir, { recursive: true, mode: 0o700 });
  try {
    const userTemplateDir = await deps.userTemplateDir();
    if (userTemplateDir) {
      try {
        if ((await stat(userTemplateDir)).isDirectory()) {
          await cp(userTemplateDir, templateDir, { recursive: true, force: true });
          const userConfig = join(userTemplateDir, "config");
          let source;
          try {
            source = await lstat(userConfig);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (source?.isSymbolicLink()) {
            const contents = await readFile(userConfig);
            const target = join(templateDir, "config");
            const mode = (await stat(userConfig)).mode & 0o777;
            await rm(target, { force: true });
            await writeFile(target, contents, { mode });
            await chmod(target, mode);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await deps.setTemplateConfig(join(templateDir, "config"), CREATED_BY_WORK_CONFIG_KEY, input.workId);
    return templateDir;
  } catch (error) {
    await rm(templateDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function removeWorkGitTemplate(templateDir: string): Promise<void> {
  await rm(templateDir, { recursive: true, force: true });
}

export async function clearWorkGitTemplates(dataDir: string): Promise<number> {
  const templateRoot = join(dataDir, WORK_GIT_TEMPLATES_DIRNAME);
  let entries;
  try {
    entries = await readdir(templateRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  await rm(templateRoot, { recursive: true, force: true });
  return entries.length;
}
