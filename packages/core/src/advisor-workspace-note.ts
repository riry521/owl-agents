import { ADVISOR_WORKSPACE_API_PATH } from "@owl/shared";
import type { AdvisorSessionDirectory } from "./types";

/** The `## Advisor workspace` section of the Advisor system prompt: where it runs, how to read the latest base, and how to ask for a writable worktree. */
export function renderAdvisorWorkspaceNote(directory: AdvisorSessionDirectory): string {
  const lines: string[] = ["## Advisor workspace"];
  if (directory.kind === "repository") {
    const { cwd, repository_root: root, base_branch: base } = directory;
    lines.push(
      `- Your working directory ${cwd} is an empty scratch directory owned by Owl; it is not a repository. Do not create project files there.`,
      `- The target repository is ${root} and its base branch is ${base}. Read the latest base only through Git objects, for example: git -C ${root} show ${base}:<path>, git -C ${root} grep -n <pattern> ${base}, git -C ${root} ls-tree -r --name-only ${base}, git -C ${root} log ${base}. Never edit, checkout, stash or run status in ${root}; it is the Owner's checkout and its files may differ from the base.`,
    );
  } else {
    lines.push(`- Your working directory ${directory.cwd} is the Project directory itself (not a Git repository); edits apply to it directly.`);
  }
  lines.push(
    `- Only when the operator explicitly asked you to do the work yourself without a Work, first call the Owl API POST ${ADVISOR_WORKSPACE_API_PATH} with the owl-api request tool (body {} for this repository, or {"project_id": "<catalog id>"} for another Project). Work only inside the returned worktree_path, with absolute paths or git -C <worktree_path>. If the response says synced is false, tell the operator about the retained changes before continuing.`,
    "- For another Project in the catalog, read its latest base the same way using its repository path and base branch.",
  );
  return lines.join("\n");
}
