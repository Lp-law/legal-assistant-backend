import express, { Request, Response } from "express";
import pool from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import type { AiUsageSummaryResponse } from "../types.js";

const router = express.Router();

router.use(authMiddleware);

router.use((req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin access only." });
  }
  next();
});

const sanitizeRangeDays = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(parsed)) {
    return 30;
  }
  return Math.min(Math.max(parsed, 1), 365);
};

router.get("/ai-usage", async (req: Request, res: Response) => {
  const rangeDays = sanitizeRangeDays(req.query.rangeDays as string | undefined);
  const interval = `${rangeDays} days`;

  try {
    const summaryResult = await pool.query(
      `
        SELECT
          COUNT(*)::int AS total_calls,
          COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
          COALESCE(SUM(cost_usd), 0)::numeric AS total_cost_usd,
          COALESCE(AVG(duration_ms), 0)::numeric AS avg_duration_ms
        FROM ai_usage_logs
        WHERE created_at >= NOW() - ($1)::interval;
      `,
      [interval]
    );

    const byActionResult = await pool.query(
      `
        SELECT
          action,
          COUNT(*)::int AS total_calls,
          COALESCE(SUM(prompt_tokens), 0)::bigint AS total_prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::bigint AS total_completion_tokens,
          COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
          COALESCE(SUM(cost_usd), 0)::numeric AS total_cost_usd,
          COALESCE(AVG(duration_ms), 0)::numeric AS avg_duration_ms
        FROM ai_usage_logs
        WHERE created_at >= NOW() - ($1)::interval
        GROUP BY action
        ORDER BY action;
      `,
      [interval]
    );

    const recentResult = await pool.query(
      `
        SELECT
          id,
          case_id,
          username,
          action,
          status,
          duration_ms,
          cost_usd,
          created_at
        FROM ai_usage_logs
        WHERE created_at >= NOW() - ($1)::interval
        ORDER BY created_at DESC
        LIMIT 40;
      `,
      [interval]
    );

    const summaryRow = summaryResult.rows[0] ?? {
      total_calls: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      avg_duration_ms: 0,
    };

    const payload: AiUsageSummaryResponse = {
      rangeDays,
      summary: {
        totalCalls: Number(summaryRow.total_calls) || 0,
        totalTokens: Number(summaryRow.total_tokens) || 0,
        totalCostUsd: Number(summaryRow.total_cost_usd) || 0,
        avgDurationMs: Number(summaryRow.avg_duration_ms) || 0,
      },
      byAction: byActionResult.rows.map((row) => ({
        action: row.action,
        totalCalls: Number(row.total_calls) || 0,
        totalPromptTokens: Number(row.total_prompt_tokens) || 0,
        totalCompletionTokens: Number(row.total_completion_tokens) || 0,
        totalTokens: Number(row.total_tokens) || 0,
        totalCostUsd: Number(row.total_cost_usd) || 0,
        avgDurationMs: Number(row.avg_duration_ms) || 0,
      })),
      recent: recentResult.rows.map((row) => ({
        id: row.id,
        caseId: row.case_id,
        username: row.username,
        action: row.action,
        status: row.status,
        durationMs: row.duration_ms ? Number(row.duration_ms) : null,
        costUsd: row.cost_usd !== null ? Number(row.cost_usd) : null,
        createdAt: row.created_at,
      })),
    };

    res.json(payload);
  } catch (error) {
    console.error("Failed to fetch AI usage summary:", error);
    res.status(500).json({ message: "Failed to retrieve AI usage data." });
  }
});

export default router;

