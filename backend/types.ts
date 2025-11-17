export type UserRole = "admin" | "user";

export type AppState = "idle" | "loading" | "success" | "error" | "processing";

export interface JwtUserPayload {
  username: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

export interface FocusOptions {
  negligence: boolean;
  causation: boolean;
  lifeExpectancy: boolean;
  [key: string]: boolean;
}

export interface CaseDbRow {
  id: string;
  name: string;
  created_at: string;
  owner: string;
  focus_options: FocusOptions;
  focus_text: string;
  initial_report: string | null;
  comparison_report: string | null;
  app_state: AppState;
}

export interface CaseData {
  id: string;
  name: string;
  createdAt: string;
  owner: string;
  focusOptions: FocusOptions;
  focusText: string;
  initialReport: string | null;
  comparisonReport: string | null;
  appState: AppState;
}

export interface CaseDocumentRow {
  id: string;
  case_id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  extracted_text: string | null;
  created_at: string;
}

export interface CaseDocument {
  id: string;
  caseId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string | null;
  createdAt: string;
}

export interface DocumentClaimRow {
  id: string;
  case_id: string;
  document_id: string;
  sort_index: number;
  claim_title: string;
  claim_summary: string;
  category: string;
  confidence: number | null;
  source_excerpt: string | null;
  recommendation: string | null;
  tags: string[] | null;
  created_at: string;
}

export interface DocumentClaim {
  id: string;
  caseId: string;
  documentId: string;
  orderIndex: number;
  claimTitle: string;
  claimSummary: string;
  category: string;
  confidence: number | null;
  sourceExcerpt: string | null;
  recommendation: string | null;
  tags: string[];
  createdAt: string;
}

export interface ComparisonReportRequest {
  reportAId?: string;
  reportBId?: string;
  reportAText?: string;
  reportBText?: string;
}

export interface LiteratureReviewRequest {
  clinicalQuestion: string;
}

export interface LiteratureSource {
  title: string;
  journal?: string;
  year?: number;
  url?: string;
  summary: string;
  implication: string;
}

export interface LiteratureReviewResult {
  question: string;
  sources: LiteratureSource[];
  overallSummary: string;
  searchSuggestions?: string[];
}

export type CaseActivityEventType = "case-created" | "document-uploaded" | "ai-event";

export interface CaseActivityEvent {
  id: string;
  type: CaseActivityEventType;
  title: string;
  description: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface AiUsageLogRow {
  id: string;
  case_id: string;
  username: string;
  action: string;
  status: string;
  model: string | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  error_message: string | null;
  created_at: string;
}

export interface ApiErrorResponse {
  message: string;
  details?: string;
}

export interface AiUsageSummary {
  totalCalls: number;
  totalCostUsd: number;
  avgDurationMs: number;
  totalTokens: number;
}

export interface AiUsageByAction {
  action: string;
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

export interface AiUsageRecentEvent {
  id: string;
  caseId: string;
  username: string;
  action: string;
  status: "success" | "error";
  durationMs: number | null;
  costUsd: number | null;
  createdAt: string;
}

export interface AiUsageSummaryResponse {
  rangeDays: number;
  summary: AiUsageSummary;
  byAction: AiUsageByAction[];
  recent: AiUsageRecentEvent[];
}

export interface CaseActivityResponse {
  events: CaseActivityEvent[];
}
