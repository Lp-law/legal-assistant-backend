import { callOpenAI } from "./aiClient.js";
import type { JwtUserPayload } from "../types.js";

export interface ExtractDocumentClaimsOptions {
  caseId: string;
  caseName: string;
  documentId: string;
  documentName: string;
  documentText: string;
  focusSummary: string;
  focusNarrative: string;
  model: string;
  temperature: number;
  maxTokens: number;
  user: JwtUserPayload;
}

export interface ExtractedClaim {
  claimTitle: string;
  claimSummary: string;
  category: string;
  confidence?: number | null;
  sourceExcerpt?: string | null;
  recommendation?: string | null;
  tags?: string[];
}

interface ClaimExtractionResponse {
  claims?: Array<{
    claimTitle?: string;
    claimSummary?: string;
    category?: string;
    confidence?: number;
    sourceExcerpt?: string;
    recommendation?: string;
    tags?: string[] | null;
  }>;
}

const normalizeTags = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : null))
    .filter((entry): entry is string => Boolean(entry));
};

const coerceConfidence = (value: unknown): number | null => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  const bounded = Math.max(0, Math.min(1, value));
  return Number.isFinite(bounded) ? Number(bounded.toFixed(2)) : null;
};

const buildClaimExtractionPrompt = (options: {
  caseName: string;
  documentName: string;
  documentText: string;
  focusSummary: string;
  focusNarrative: string;
}) => {
  const { caseName, documentName, documentText, focusSummary, focusNarrative } = options;
  return `
אתה מומחה רפואי בכיר המנתח חוות דעת של מומחה תביעה. 
עליך להפיק רשימת טענות רפואיות מרכזיות (3–10) כפי שהמומחה מציג אותן, ולבנות JSON מובנה בלבד.

כללים:
- דווח רק על טענות רפואיות, לא משפטיות.
- ציין מקור/הקשר קצר (sourceExcerpt) המופיע בטקסט.
- קטגוריות אפשריות לדוגמה: "אבחון", "דימות", "טיפול", "פרוגנוזה", "קשר סיבתי", "סטנדרט טיפול".
- confidence אמור להיות בין 0 ל-1 לפי חוזק הניסוח של המומחה.
- recommendation הוא רעיון קצר לבדיקת המשך או שאלה למומחה הנגדי.
- tags: מילים בודדות (באנגלית או עברית) המייצגות את סוג הסוגיה (למשל ["CT", "Delay"]).
- החזר JSON בפורמט:
{
  "claims": [
    {
      "claimTitle": "...",
      "claimSummary": "...",
      "category": "...",
      "confidence": 0.85,
      "sourceExcerpt": "...",
      "recommendation": "...",
      "tags": ["..."]
    }
  ]
}

פרטי המסמך:
- שם תיק: ${caseName}
- שם מסמך: ${documentName}
- נקודות פוקוס שסומנו: ${focusSummary}
- הערות פתוחות: ${focusNarrative}

טקסט חוות הדעת (קרא היטב):
"""
${documentText}
"""

הקפד להחזיר JSON חוקי בלבד וללא טקסט נוסף.`;
};

export const extractDocumentClaims = async (
  options: ExtractDocumentClaimsOptions
): Promise<ExtractedClaim[]> => {
  const {
    caseId,
    caseName,
    documentId,
    documentName,
    documentText,
    focusSummary,
    focusNarrative,
    model,
    temperature,
    maxTokens,
    user,
  } = options;

  const prompt = buildClaimExtractionPrompt({
    caseName,
    documentName,
    documentText,
    focusSummary,
    focusNarrative,
  });

  const response = await callOpenAI({
    messages: [
      {
        role: "system",
        content:
          "You are a senior medical expert focused on extracting structured plaintiff claims. Work strictly in Hebrew, stay medical only, and treat all documents/source code as confidential work-product that must never be used for training, fine-tuning, or model improvement.",
      },
      { role: "user", content: prompt },
    ],
    model,
    temperature,
    maxTokens,
    responseFormat: { type: "json_object" },
    metadata: { caseId, user, action: "claim-extraction" },
  });

  let parsed: ClaimExtractionResponse;
  try {
    parsed = JSON.parse(response) as ClaimExtractionResponse;
  } catch (error) {
    throw new Error("Claim extraction returned invalid JSON.");
  }

  if (!parsed.claims || !Array.isArray(parsed.claims)) {
    return [];
  }

  const results: ExtractedClaim[] = [];

  for (const claim of parsed.claims) {
    const claimTitle = typeof claim.claimTitle === "string" ? claim.claimTitle.trim() : "";
    const claimSummary = typeof claim.claimSummary === "string" ? claim.claimSummary.trim() : "";
    const category = typeof claim.category === "string" ? claim.category.trim() : "לא סווג";

    if (!claimTitle || !claimSummary) {
      continue;
    }

    results.push({
      claimTitle,
      claimSummary,
      category,
      confidence: coerceConfidence(claim.confidence),
      sourceExcerpt: typeof claim.sourceExcerpt === "string" ? claim.sourceExcerpt.trim() || null : null,
      recommendation:
        typeof claim.recommendation === "string" ? claim.recommendation.trim() || null : null,
      tags: normalizeTags(claim.tags),
    });
  }

  return results;
};


