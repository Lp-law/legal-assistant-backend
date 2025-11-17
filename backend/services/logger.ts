import pool from "../db.js";

interface AiLogParams {
  readonly caseId: string;
  readonly username: string;
  readonly action: string;
  readonly status: "success" | "error";
  readonly durationMs?: number | null;
  readonly errorMessage?: string | null;
  readonly model?: string;
  readonly promptTokens?: number | null;
  readonly completionTokens?: number | null;
  readonly totalTokens?: number | null;
  readonly costUsd?: number | null;
}

export const logAiEvent = async (params: AiLogParams) => {
  const {
    caseId,
    username,
    action,
    status,
    durationMs,
    errorMessage,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd,
  } = params;
  const base = `[AI][${action}] case=${caseId} user=${username} status=${status}`;
  const details = [
    durationMs ? `t=${durationMs}ms` : null,
    promptTokens ? `prompt=${promptTokens}` : null,
    completionTokens ? `completion=${completionTokens}` : null,
    costUsd ? `cost=$${costUsd.toFixed(4)}` : null,
    errorMessage ? `error="${errorMessage}"` : null,
  ]
    .filter(Boolean)
    .join(" ");

  console.info(details ? `${base} ${details}` : base);

  try {
    await pool.query(
      `
        INSERT INTO ai_usage_logs (
          case_id,
          username,
          action,
          status,
          model,
          duration_ms,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          cost_usd,
          error_message
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
      `,
      [
        caseId,
        username,
        action,
        status,
        model ?? null,
        durationMs ?? null,
        promptTokens ?? null,
        completionTokens ?? null,
        totalTokens ?? null,
        costUsd ?? null,
        errorMessage ?? null,
      ]
    );
  } catch (dbError) {
    console.error("Failed to persist AI usage log:", dbError);
  }
};