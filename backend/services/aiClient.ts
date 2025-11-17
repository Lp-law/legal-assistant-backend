import type { JwtUserPayload } from "../types.js";
import { logAiEvent } from "./logger.js";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface CallOpenAIOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: Record<string, unknown>;
  metadata?: {
    caseId: string;
    user: JwtUserPayload;
    action: "initial-report" | "comparison-report" | "literature-review" | "claim-extraction";
  };
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_URL = process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions";
const INPUT_COST_PER_1K = Number(process.env.OPENAI_INPUT_COST_PER_1K ?? "0.15");
const OUTPUT_COST_PER_1K = Number(process.env.OPENAI_OUTPUT_COST_PER_1K ?? "0.60");

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

const toNumberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const estimateCostUsd = (promptTokens: number | null, completionTokens: number | null): number | null => {
  const promptCost = promptTokens ? (promptTokens / 1000) * INPUT_COST_PER_1K : 0;
  const completionCost = completionTokens ? (completionTokens / 1000) * OUTPUT_COST_PER_1K : 0;
  const combined = promptCost + completionCost;
  if (!Number.isFinite(combined) || combined === 0) {
    return null;
  }
  return Number(combined.toFixed(6));
};

if (!OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY is not defined. AI endpoints will fail until it is configured.");
}

export const callOpenAI = async (options: CallOpenAIOptions): Promise<string> => {
  const { messages, model = OPENAI_MODEL, temperature = 0.2, maxTokens = 1500, responseFormat, metadata } = options;

  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const requestBody: Record<string, unknown> = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages,
  };

  if (responseFormat) {
    requestBody.response_format = responseFormat;
  }

  const startedAt = Date.now();

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();

    if (!response.ok) {
      const message = data?.error?.message || "OpenAI API error";
      throw new Error(message);
    }

    const content: string | undefined = data?.choices?.[0]?.message?.content;
    const cleanedContent = content?.trim() ?? "";
    const usage: OpenAIUsage | undefined = data?.usage;
    const promptTokens = toNumberOrNull(usage?.prompt_tokens);
    const completionTokens = toNumberOrNull(usage?.completion_tokens);
    const totalTokens =
      toNumberOrNull(usage?.total_tokens) ??
      (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
    const costUsd = estimateCostUsd(promptTokens, completionTokens);
    const durationMs = Date.now() - startedAt;

    if (metadata) {
      await logAiEvent({
        caseId: metadata.caseId,
        username: metadata.user.username,
        action: metadata.action,
        status: "success",
        durationMs,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        costUsd,
      });
    }

    return cleanedContent;
  } catch (error) {
    if (metadata) {
      await logAiEvent({
        caseId: metadata.caseId,
        username: metadata.user.username,
        action: metadata.action,
        status: "error",
        durationMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
        model,
      });
    }
    throw error;
  }
};

