import type Database from "better-sqlite3";
import { createUlid, utcNow } from "./ids";

type SqliteDatabase = Database.Database;
type SqliteValue = string | number | bigint | Buffer | null;

export interface WriteLaneTransaction {
  run(sql: string, ...parameters: SqliteValue[]): Database.RunResult;
  get<T extends object>(sql: string, ...parameters: SqliteValue[]): T | undefined;
  all<T extends object>(sql: string, ...parameters: SqliteValue[]): T[];
}

export interface EventToAppend {
  readonly id?: string;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly workId?: string | null;
  readonly taskId?: string | null;
  readonly agentRunId?: string | null;
  readonly payload: unknown;
  readonly createdAt?: string;
}

export interface OutboxDeliveryToCreate {
  readonly provider: string;
  readonly providerMessageKey?: string;
}

export interface WriteLaneRequest<StateResult> {
  readonly mutateState: (transaction: WriteLaneTransaction) => StateResult;
  readonly event: EventToAppend;
  readonly outbox: readonly OutboxDeliveryToCreate[];
}

export interface WriteLaneResult<StateResult> {
  readonly state: StateResult;
  readonly eventId: string;
  readonly sequence: number;
  readonly outboxIds: readonly string[];
}

export interface WriteLaneTransactionResult<StateResult> {
  readonly state: StateResult;
}

/**
 * SQLite already ends the transaction itself on some errors (RAISE(ROLLBACK),
 * SQLITE_FULL, ...). A second ROLLBACK would then throw "no transaction is
 * active" and replace the error that explains the failure.
 */
export function rollbackIfOpen(database: SqliteDatabase, transactionStarted: boolean): void {
  if (transactionStarted && database.inTransaction) database.exec("ROLLBACK");
}

/**
 * The only write entry point exposed by the package. Calls are serialized and
 * each state mutation, event append, and outbox insert uses one transaction.
 * The callback receives database primitives only; external I/O is intentionally
 * not part of this API and must happen after the returned Promise resolves.
 */
export class WriteLane {
  private queue: Promise<void> = Promise.resolve();

  private constructor(private readonly database: SqliteDatabase) {}

  public static create(database: SqliteDatabase): WriteLane {
    return new WriteLane(database);
  }

  public write<StateResult>(request: WriteLaneRequest<StateResult>): Promise<WriteLaneResult<StateResult>> {
    const operation = this.queue.then(() => this.writeNow(request));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** Serialized bookkeeping transaction for delivery metadata only. */
  public transact<StateResult>(mutateState: (transaction: WriteLaneTransaction) => StateResult): Promise<StateResult> {
    const operation = this.queue.then(() => this.transactNow(mutateState));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  public async drain(): Promise<void> {
    await this.queue;
  }

  private writeNow<StateResult>(request: WriteLaneRequest<StateResult>): WriteLaneResult<StateResult> {
    const eventId = request.event.id ?? createUlid();
    const createdAt = request.event.createdAt ?? utcNow();
    const payloadJson = JSON.stringify(request.event.payload);
    if (payloadJson === undefined) {
      throw new TypeError("Event payload must be JSON serializable.");
    }
    const duplicateProviders = new Set<string>();
    for (const delivery of request.outbox) {
      if (duplicateProviders.has(delivery.provider)) {
        throw new Error("Each event may have at most one outbox delivery per provider.");
      }
      duplicateProviders.add(delivery.provider);
    }

    let transactionStarted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      // Some state reducers create rows referenced by the canonical event
      // (for example agent_runs for task.started), while inbound receipt
      // reducers reference the event row itself. Defer all FK checks until
      // COMMIT so both sides can be created in this one atomic transaction.
      this.database.exec("PRAGMA defer_foreign_keys = ON");
      const transaction = this.transactionApi();
      const sequenceRow = transaction.get<{ next_sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM events",
      );
      if (!sequenceRow || !Number.isSafeInteger(sequenceRow.next_sequence) || sequenceRow.next_sequence < 1) {
        throw new Error("Event sequence allocation failed.");
      }
      transaction.run(
        `INSERT INTO events
         (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id,
          payload_json, status, attempt_no, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
        eventId,
        sequenceRow.next_sequence,
        request.event.idempotencyKey,
        request.event.type,
        request.event.workId ?? null,
        request.event.taskId ?? null,
        request.event.agentRunId ?? null,
        payloadJson,
        createdAt,
      );

      // The state callback may need to reference this event through a foreign
      // key (for example inbound_receipts.event_id). Insert it before the
      // callback while remaining inside the same transaction; any callback
      // failure rolls the event back together with the state mutation.
      const state = request.mutateState(transaction);

      const outboxIds: string[] = [];
      for (const delivery of request.outbox) {
        const deliveryId = createUlid();
        transaction.run(
          `INSERT INTO outbox_deliveries
           (id, event_id, provider, provider_message_key, status, attempt_no)
           VALUES (?, ?, ?, ?, 'pending', 0)`,
          deliveryId,
          eventId,
          delivery.provider,
          delivery.providerMessageKey ?? `${eventId}:${delivery.provider}`,
        );
        outboxIds.push(deliveryId);
      }

      this.database.exec("COMMIT");
      transactionStarted = false;
      return {
        state,
        eventId,
        sequence: sequenceRow.next_sequence,
        outboxIds,
      };
    } catch (error) {
      rollbackIfOpen(this.database, transactionStarted);
      throw error;
    }
  }

  private transactNow<StateResult>(mutateState: (transaction: WriteLaneTransaction) => StateResult): StateResult {
    let transactionStarted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const state = mutateState(this.transactionApi());
      this.database.exec("COMMIT");
      transactionStarted = false;
      return state;
    } catch (error) {
      rollbackIfOpen(this.database, transactionStarted);
      throw error;
    }
  }

  private transactionApi(): WriteLaneTransaction {
    return {
      run: (sql, ...parameters) => this.database.prepare(sql).run(...parameters),
      get: <T extends object>(sql: string, ...parameters: SqliteValue[]) =>
        this.database.prepare(sql).get(...parameters) as T | undefined,
      all: <T extends object>(sql: string, ...parameters: SqliteValue[]) =>
        this.database.prepare(sql).all(...parameters) as T[],
    };
  }
}
