import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DESIGN_MOCK_FILE_PATTERN, designMockDirectory, isScreenDesignTask } from "../../shared/dist/index.js";
import { HumanReadableError, validationError } from "./errors";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types";

export interface DesignMockSummary {
  readonly task_id: string;
  readonly task_title: string;
  readonly name: string;
  readonly updated_at: string;
  readonly size_bytes: number;
}

export interface DesignMockStoreOptions {
  readonly db: CoreDatabase;
  readonly writeLane: { transact<T>(mutate: (transaction: CoreWriteLaneTransaction) => T): Promise<T> };
  readonly dataDir: string;
  readonly now: () => string;
}

interface ScreenDesignRun {
  readonly id: string;
  readonly work_id: string;
}

type DirectoryIdentity = { readonly path: string; readonly dev: number; readonly ino: number };

function scopeDenied(): HumanReadableError {
  return new HumanReadableError({
    code: "design_mock_scope_denied",
    message: "Design mocks can be saved only from a Designer run of a screen design Task.",
    remediation: "Save mocks from the Designer run of the Task the Manager assigned to the Lead Designer.",
  });
}

function writeFailed(message: string, cause?: unknown): HumanReadableError {
  console.warn(`[owl-core] Design mock export failed: ${message}`, cause ?? "");
  return new HumanReadableError({
    code: "design_mock_write_failed",
    message: `The design mock could not be written: ${message}`,
    remediation: "Check the Task's mock directory under the data directory and save the mock again.",
  });
}

/**
 * HTML mocks of screen design Tasks. The DB table is the source for listing and serving;
 * the files under the mock directory are an export for agents that open them with file tools.
 */
export class DesignMockStore {
  public constructor(private readonly options: DesignMockStoreOptions) {}

  public async saveDesignMock(agentRunId: string, name: string, html: string): Promise<{ task_id: string; name: string; size_bytes: number; updated_at: string }> {
    this.validateName(name);
    if (typeof html !== "string" || html.length === 0) throw validationError("html must be a non-empty string.", { field: "html" });
    const run = this.screenDesignRun(agentRunId);
    await this.writeFile(run, name, html);
    const sizeBytes = Buffer.byteLength(html, "utf8");
    const updatedAt = this.options.now();
    await this.options.writeLane.transact((transaction) => {
      transaction.run(
        `INSERT INTO design_mocks (task_id, name, html, size_bytes, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, name) DO UPDATE SET html = excluded.html, size_bytes = excluded.size_bytes, updated_at = excluded.updated_at`,
        run.id, name, html, sizeBytes, updatedAt,
      );
    });
    return { task_id: run.id, name, size_bytes: sizeBytes, updated_at: updatedAt };
  }

  public async deleteDesignMock(agentRunId: string, name: string): Promise<{ task_id: string; name: string; deleted: boolean }> {
    this.validateName(name);
    const run = this.screenDesignRun(agentRunId);
    await this.removeFile(run, name);
    const deleted = await this.options.writeLane.transact((transaction) => {
      const row = transaction.get<{ name: string }>("SELECT name FROM design_mocks WHERE task_id = ? AND name = ?", run.id, name);
      transaction.run("DELETE FROM design_mocks WHERE task_id = ? AND name = ?", run.id, name);
      return row !== undefined;
    });
    return { task_id: run.id, name, deleted };
  }

  public listWorkDesignMocks(workId: string): DesignMockSummary[] {
    return this.options.db.all<DesignMockSummary>(
      `SELECT design_mocks.task_id, tasks.title AS task_title, design_mocks.name, design_mocks.updated_at, design_mocks.size_bytes
         FROM design_mocks JOIN tasks ON tasks.id = design_mocks.task_id
        WHERE tasks.work_id = ? AND tasks.type = 'design'
        ORDER BY tasks.created_at ASC, tasks.id ASC, design_mocks.name ASC`,
      workId,
    );
  }

  public readWorkDesignMock(workId: string, taskId: string, name: string): string | null {
    if (!DESIGN_MOCK_FILE_PATTERN.test(name)) return null;
    const row = this.options.db.get<{ html: string }>(
      `SELECT design_mocks.html
         FROM design_mocks JOIN tasks ON tasks.id = design_mocks.task_id
        WHERE tasks.work_id = ? AND design_mocks.task_id = ? AND design_mocks.name = ?
          AND tasks.type = 'design'`,
      workId, taskId, name,
    );
    return row?.html ?? null;
  }

  private validateName(name: string): void {
    if (typeof name !== "string" || !DESIGN_MOCK_FILE_PATTERN.test(name)) {
      throw validationError("name must be lowercase letters, digits and hyphens with the .html extension.", { field: "name" });
    }
  }

  private screenDesignRun(agentRunId: string): ScreenDesignRun {
    const row = this.options.db.get<{ id: string; work_id: string; type: string }>(
      `SELECT tasks.id, tasks.work_id, tasks.type
         FROM agent_runs JOIN tasks ON tasks.id = agent_runs.task_id
        WHERE agent_runs.id = ? AND agent_runs.role = 'designer'`,
      agentRunId,
    );
    if (!row || !isScreenDesignTask(row)) throw scopeDenied();
    return { id: row.id, work_id: row.work_id };
  }

  /** The two directory levels under the trusted designs root, which must stay real directories. */
  private async checkedDirectories(run: ScreenDesignRun): Promise<{ dir: string; identities: DirectoryIdentity[] }> {
    const dir = designMockDirectory(this.options.dataDir, run.work_id, run.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return { dir, identities: await this.identify(dir) };
  }

  private async identify(dir: string): Promise<DirectoryIdentity[]> {
    const identities: DirectoryIdentity[] = [];
    for (const path of [dirname(dir), dir]) {
      const details = await lstat(path);
      if (!details.isDirectory() || details.isSymbolicLink()) throw writeFailed(`${path} is not a plain directory.`);
      identities.push({ path, dev: details.dev, ino: details.ino });
    }
    return identities;
  }

  private async assertUnchanged(identities: readonly DirectoryIdentity[]): Promise<void> {
    for (const before of identities) {
      const details = await lstat(before.path);
      if (!details.isDirectory() || details.isSymbolicLink() || details.dev !== before.dev || details.ino !== before.ino) {
        throw writeFailed(`${before.path} changed while the mock was written.`);
      }
    }
  }

  /**
   * Why a new temp file plus rename: O_EXCL never opens an existing file or link, and rename
   * replaces a symlink or hard link at the mock name instead of writing through it.
   */
  private async writeFile(run: ScreenDesignRun, name: string, html: string): Promise<void> {
    let tempPath: string | null = null;
    try {
      const { dir, identities } = await this.checkedDirectories(run);
      tempPath = join(dir, `.${name}.${randomUUID()}.tmp`);
      const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(html, "utf8");
      } finally {
        await handle.close();
      }
      await rename(tempPath, join(dir, name));
      tempPath = null;
      await this.assertUnchanged(identities);
    } catch (error) {
      // Why ignore: the original failure is what the caller needs; a leftover dot-file is harmless.
      if (tempPath !== null) await unlink(tempPath).catch(() => undefined);
      throw error instanceof HumanReadableError ? error : writeFailed(error instanceof Error ? error.message : String(error), error);
    }
  }

  private async removeFile(run: ScreenDesignRun, name: string): Promise<void> {
    try {
      const { dir } = await this.checkedDirectories(run);
      await unlink(join(dir, name));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw error instanceof HumanReadableError ? error : writeFailed(error instanceof Error ? error.message : String(error), error);
    }
  }
}
