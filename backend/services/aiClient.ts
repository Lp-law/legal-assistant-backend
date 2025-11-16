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
    action: "initial-report" | "comparison-report" | "literature-review";
  };
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_URL = process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions";

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

    if (metadata) {
      logAiEvent({
        caseId: metadata.caseId,
        username: metadata.user.username,
        action: metadata.action,
        status: "success",
        durationMs: Date.now() - startedAt,
      });
    }

    return cleanedContent;
  } catch (error) {
    if (metadata) {
      logAiEvent({
        caseId: metadata.caseId,
        username: metadata.user.username,
        action: metadata.action,
        status: "error",
        durationMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
};

