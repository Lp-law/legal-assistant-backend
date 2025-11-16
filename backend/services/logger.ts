interface AiLogParams {
  readonly caseId: string;
  readonly username: string;
  readonly action: string;
  readonly status: "success" | "error";
  readonly durationMs?: number;
  readonly errorMessage?: string;
}

export const logAiEvent = (params: AiLogParams) => {
  const { caseId, username, action, status, durationMs, errorMessage } = params;
  const base = `[AI][${action}] case=${caseId} user=${username} status=${status}`;
  const details = [
    durationMs ? `t=${durationMs}ms` : null,
    errorMessage ? `error="${errorMessage}"` : null,
  ]
    .filter(Boolean)
    .join(" ");

  console.info(details ? `${base} ${details}` : base);
};

