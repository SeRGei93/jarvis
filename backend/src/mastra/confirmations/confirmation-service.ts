import { eq, and } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../db/schema.js";
import { pendingConfirmations, cronTasks } from "../../db/schema.js";
import { MemoryService } from "../memory/memory-service.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "confirmations" });

type Db = LibSQLDatabase<typeof schema>;

export interface ConfirmationCreate {
  userId: number;
  chatId: number;
  sessionId: number | null;
  toolName: string;
  args: unknown;
  summary: string;
}

/** A pending confirmation surfaced to the UI (Telegram approve/decline buttons). */
export interface ConfirmationRequest {
  id: number;
  toolName: string;
  summary: string;
}

export interface ConfirmationResult {
  ok: boolean;
  message: string;
}

/** Executes an approved risky action and returns a user-facing result message. */
export type ConfirmationExecutor = (
  args: Record<string, unknown>,
  deps: { db: Db; mem: MemoryService; userId: number },
) => Promise<string>;

/**
 * The risky tools that require confirm-before-execute, mapped to the action run
 * on approval. Adding a tool here makes it gated everywhere (its tool records a
 * confirmation instead of acting). Today: destructive deletes only.
 */
export function defaultExecutors(): Record<string, ConfirmationExecutor> {
  return {
    forget: async (args, { mem, userId }) => {
      const id = Number(args.memory_id);
      const ok = await mem.delete(userId, id);
      return ok ? `Запись #${id} удалена из памяти.` : `Запись #${id} не найдена.`;
    },
    task_delete: async (args, { db, userId }) => {
      const id = Number(args.task_id);
      await db.delete(cronTasks).where(and(eq(cronTasks.id, id), eq(cronTasks.userId, userId)));
      return `Задача #${id} удалена.`;
    },
  };
}

/**
 * Confirm-before-execute for risky tools (C1). A risky tool calls `create()`
 * instead of acting; the user approves/declines out of band (Telegram buttons),
 * and `resolve()` runs the recorded action on approval. Durable via our own
 * `pending_confirmations` table — NOT Mastra suspend/resume snapshots, so the
 * schema stays under our migration control. Every query is scoped by userId.
 */
export class ConfirmationService {
  private readonly executors: Record<string, ConfirmationExecutor>;

  constructor(
    private readonly db: Db,
    private readonly mem: MemoryService,
    executors: Record<string, ConfirmationExecutor> = defaultExecutors(),
  ) {
    this.executors = executors;
  }

  /** True when a tool must be confirmed before it runs. */
  requiresConfirmation(toolName: string): boolean {
    return toolName in this.executors;
  }

  /** Record a pending confirmation; returns the id + summary for the UI buttons. */
  async create(c: ConfirmationCreate): Promise<ConfirmationRequest> {
    const [row] = await this.db
      .insert(pendingConfirmations)
      .values({
        userId: c.userId,
        chatId: c.chatId,
        sessionId: c.sessionId,
        toolName: c.toolName,
        args: c.args,
        summary: c.summary,
        status: "pending",
      })
      .returning();
    log.info({ id: row!.id, tool: c.toolName, userId: c.userId }, "confirmation created");
    return { id: row!.id, toolName: row!.toolName, summary: row!.summary };
  }

  /** Pending confirmation ids for a user/session — used to diff "new this turn". */
  async pendingIds(userId: number, sessionId: number | null): Promise<Set<number>> {
    const rows = await this.db
      .select({ id: pendingConfirmations.id })
      .from(pendingConfirmations)
      .where(
        and(
          eq(pendingConfirmations.userId, userId),
          eq(pendingConfirmations.status, "pending"),
          sessionId != null ? eq(pendingConfirmations.sessionId, sessionId) : undefined,
        ),
      );
    return new Set(rows.map((r) => r.id));
  }

  /** Pending confirmation requests for a user/session (id + toolName + summary). */
  async listPending(userId: number, sessionId: number | null): Promise<ConfirmationRequest[]> {
    const rows = await this.db
      .select({
        id: pendingConfirmations.id,
        toolName: pendingConfirmations.toolName,
        summary: pendingConfirmations.summary,
      })
      .from(pendingConfirmations)
      .where(
        and(
          eq(pendingConfirmations.userId, userId),
          eq(pendingConfirmations.status, "pending"),
          sessionId != null ? eq(pendingConfirmations.sessionId, sessionId) : undefined,
        ),
      );
    return rows;
  }

  /**
   * Resolve a pending confirmation. Scoped by userId so one user can't approve
   * another's action. On approval runs the recorded executor; declines/errors
   * leave nothing executed. Idempotent: a non-pending row returns ok:false.
   */
  async resolve(userId: number, id: number, approved: boolean): Promise<ConfirmationResult> {
    const [row] = await this.db
      .select()
      .from(pendingConfirmations)
      .where(and(eq(pendingConfirmations.id, id), eq(pendingConfirmations.userId, userId)));

    if (!row) {
      log.warn({ id, userId }, "confirmation not found");
      return { ok: false, message: "Запрос не найден." };
    }
    if (row.status !== "pending") {
      return { ok: false, message: "Этот запрос уже обработан." };
    }
    if (!approved) {
      await this.mark(id, "declined");
      log.info({ id, tool: row.toolName }, "confirmation declined");
      return { ok: true, message: "Отменено." };
    }

    const exec = this.executors[row.toolName];
    if (!exec) {
      await this.mark(id, "declined");
      log.warn({ id, tool: row.toolName }, "no executor for confirmed tool");
      return { ok: false, message: "Неизвестное действие." };
    }
    try {
      const message = await exec((row.args ?? {}) as Record<string, unknown>, {
        db: this.db,
        mem: this.mem,
        userId,
      });
      await this.mark(id, "approved");
      log.info({ id, tool: row.toolName }, "confirmation approved + executed");
      return { ok: true, message };
    } catch (err) {
      log.warn({ id, reason: err instanceof Error ? err.message : String(err) }, "confirmation execute failed");
      return { ok: false, message: "Не удалось выполнить действие." };
    }
  }

  private async mark(id: number, status: "approved" | "declined"): Promise<void> {
    await this.db
      .update(pendingConfirmations)
      .set({ status, updatedAt: new Date() })
      .where(eq(pendingConfirmations.id, id));
  }
}
