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

export interface ApiErrorResponse {
  message: string;
  details?: string;
}
