import express, { Request, Response } from "express";
import multer, { MulterError } from "multer";
import { v4 as uuidv4 } from "uuid";
import { authMiddleware } from "../middleware/authMiddleware.js";
import pool from "../db.js";
import { extractTextFromBuffer, resolveDocumentType } from "../services/documentProcessor.js";
import { callOpenAI } from "../services/aiClient.js";
import {
  detectReferenceCandidates,
  resolveLiteratureReferences,
  type CitationCandidate,
  type ResolvedLiteratureItem,
} from "../services/medicalLiteratureService.js";
import type {
  AiUsageLogRow,
  AppState,
  CaseActivityEvent,
  CaseActivityResponse,
  CaseData,
  CaseDbRow,
  CaseDocument,
  CaseDocumentRow,
  ComparisonReportRequest,
  FocusOptions,
  JwtUserPayload,
  LiteratureReviewRequest,
  LiteratureReviewResult,
} from "../types.js";

const router = express.Router();

const DEFAULT_MAX_UPLOAD_SIZE_MB = 25;
const DEFAULT_MAX_UPLOAD_FILES = 5;

const configuredMaxUploadSizeMb = Number(process.env.MAX_UPLOAD_SIZE_MB ?? `${DEFAULT_MAX_UPLOAD_SIZE_MB}`);
const configuredMaxUploadFiles = Number(process.env.MAX_UPLOAD_FILES ?? `${DEFAULT_MAX_UPLOAD_FILES}`);

const MAX_UPLOAD_SIZE_MB =
  Number.isFinite(configuredMaxUploadSizeMb) && configuredMaxUploadSizeMb > 0
    ? configuredMaxUploadSizeMb
    : DEFAULT_MAX_UPLOAD_SIZE_MB;

const MAX_UPLOAD_FILES =
  Number.isFinite(configuredMaxUploadFiles) && configuredMaxUploadFiles > 0
    ? configuredMaxUploadFiles
    : DEFAULT_MAX_UPLOAD_FILES;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024,
    files: MAX_UPLOAD_FILES,
  },
});
const uploadDocumentsMiddleware = upload.array("files");

const DOCUMENT_PREVIEW_LENGTH = 400;
const PROMPT_DOCUMENT_CHAR_LIMIT = 6000;
const FOCUS_OPTION_LABELS: Record<string, string> = {
  negligence: "רשלנות",
  causation: "קשר סיבתי",
  lifeExpectancy: "תוחלת חיים / נזק",
};
const DEFAULT_MAX_REFERENCES_PER_DOCUMENT = 4;
const DEFAULT_MAX_REFERENCES_PER_REPORT = 10;
const DEFAULT_INITIAL_REPORT_TOKENS = 2400;
const DEFAULT_COMPARISON_REPORT_TOKENS = 2000;
const DEFAULT_MEDICAL_REPORT_TEMPERATURE = 0.25;

const configuredMaxReferencesPerDoc = Number(process.env.MAX_REFERENCES_PER_DOCUMENT ?? `${DEFAULT_MAX_REFERENCES_PER_DOCUMENT}`);
const configuredMaxReferencesPerReport = Number(process.env.MAX_REFERENCES_PER_REPORT ?? `${DEFAULT_MAX_REFERENCES_PER_REPORT}`);
const MAX_REFERENCES_PER_DOCUMENT =
  Number.isFinite(configuredMaxReferencesPerDoc) && configuredMaxReferencesPerDoc > 0
    ? configuredMaxReferencesPerDoc
    : DEFAULT_MAX_REFERENCES_PER_DOCUMENT;
const MAX_REFERENCES_PER_REPORT =
  Number.isFinite(configuredMaxReferencesPerReport) && configuredMaxReferencesPerReport > 0
    ? configuredMaxReferencesPerReport
    : DEFAULT_MAX_REFERENCES_PER_REPORT;

const MEDICAL_REPORT_MODEL =
  process.env.MEDICAL_REPORT_MODEL || process.env.OPENAI_MEDICAL_MODEL || "gpt-4.1-mini";
const configuredInitialTokens = Number(process.env.INITIAL_REPORT_MAX_TOKENS ?? `${DEFAULT_INITIAL_REPORT_TOKENS}`);
const configuredComparisonTokens = Number(process.env.COMPARISON_REPORT_MAX_TOKENS ?? `${DEFAULT_COMPARISON_REPORT_TOKENS}`);
const INITIAL_REPORT_MAX_TOKENS =
  Number.isFinite(configuredInitialTokens) && configuredInitialTokens > 0
    ? configuredInitialTokens
    : DEFAULT_INITIAL_REPORT_TOKENS;
const COMPARISON_REPORT_MAX_TOKENS =
  Number.isFinite(configuredComparisonTokens) && configuredComparisonTokens > 0
    ? configuredComparisonTokens
    : DEFAULT_COMPARISON_REPORT_TOKENS;
const configuredTemperature = Number(process.env.MEDICAL_REPORT_TEMPERATURE ?? `${DEFAULT_MEDICAL_REPORT_TEMPERATURE}`);
const MEDICAL_REPORT_TEMPERATURE =
  Number.isFinite(configuredTemperature) && configuredTemperature >= 0
    ? configuredTemperature
    : DEFAULT_MEDICAL_REPORT_TEMPERATURE;
const MEDICAL_REPORT_DEPTH = (process.env.MEDICAL_REPORT_DEPTH ?? "deep").toLowerCase();

const garbledFilenamePattern = /[ÃÂÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ]/;

const normalizeFilename = (value: string): string => {
  if (!value) {
    return value;
  }
  const converted = Buffer.from(value, "latin1").toString("utf8");
  const hasReplacement = converted.includes("\uFFFD");
  if (!hasReplacement && (converted !== value || garbledFilenamePattern.test(value))) {
    return converted;
  }
  return value;
};

type CaseDocumentSummary = Omit<CaseDocument, "extractedText"> & {
  extractedTextPreview: string | null;
};

router.use(authMiddleware);

const requireUser = (req: Request, res: Response): JwtUserPayload | null => {
  if (!req.user) {
    res.status(401).json({ message: "Authentication required." });
    return null;
  }
  return req.user;
};

const mapCaseRowToCaseData = (row: CaseDbRow): CaseData => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  owner: row.owner,
  focusOptions: row.focus_options,
  focusText: row.focus_text,
  initialReport: row.initial_report,
  comparisonReport: row.comparison_report,
  appState: row.app_state,
});

const mapDocumentRowToDocument = (row: CaseDocumentRow): CaseDocument => ({
  id: row.id,
  caseId: row.case_id,
  originalFilename: normalizeFilename(row.original_filename),
  mimeType: row.mime_type,
  sizeBytes: row.size_bytes,
  extractedText: row.extracted_text,
  createdAt: row.created_at,
});

const summarizeDocument = (doc: CaseDocument): CaseDocumentSummary => ({
  id: doc.id,
  caseId: doc.caseId,
  originalFilename: doc.originalFilename,
  mimeType: doc.mimeType,
  sizeBytes: doc.sizeBytes,
  createdAt: doc.createdAt,
  extractedTextPreview: doc.extractedText ? doc.extractedText.slice(0, DOCUMENT_PREVIEW_LENGTH) : null,
});

const canAccessCase = (user: JwtUserPayload, caseRow: CaseDbRow) =>
  user.role === "admin" || caseRow.owner === user.username;

const truncateForPrompt = (text: string | null | undefined, limit = PROMPT_DOCUMENT_CHAR_LIMIT) => {
  if (!text) {
    return "[No extracted text available]";
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n\n[Truncated for AI prompt]`;
};

const getCaseRow = async (caseId: string): Promise<CaseDbRow | null> => {
  const result = await pool.query<CaseDbRow>("SELECT * FROM cases WHERE id = $1", [caseId]);
  return result.rows[0] ?? null;
};

const getCaseDocuments = async (caseId: string): Promise<CaseDocument[]> => {
  const result = await pool.query<CaseDocumentRow>(
    "SELECT * FROM case_documents WHERE case_id = $1 ORDER BY created_at DESC",
    [caseId]
  );
  return result.rows.map(mapDocumentRowToDocument);
};

const getCaseDocumentById = async (
  caseId: string,
  documentId: string
): Promise<CaseDocument | null> => {
  const result = await pool.query<CaseDocumentRow>(
    "SELECT * FROM case_documents WHERE case_id = $1 AND id = $2",
    [caseId, documentId]
  );
  return result.rows[0] ? mapDocumentRowToDocument(result.rows[0]) : null;
};

const setCaseAppState = async (caseId: string, state: AppState) => {
  await pool.query("UPDATE cases SET app_state = $1 WHERE id = $2", [state, caseId]);
};

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const describeFocusOptions = (options: FocusOptions) => {
  const labels = Object.entries(options)
    .filter(([, enabled]) => enabled)
    .map(([key]) => FOCUS_OPTION_LABELS[key] ?? key);
  return labels.length ? labels.join(", ") : "לא נבחרו נקודות פוקוס";
};

const isLikelyExpertOpinion = (doc: CaseDocument) => {
  const filename = doc.originalFilename.toLowerCase();
  const keywords = ["חוות", "expert", "opinion", "report", "מומח", "חוו\"ד", "expertise"];
  return keywords.some((keyword) => filename.includes(keyword));
};

const buildExpertOpinionsBlock = (docs: CaseDocument[]) => {
  if (!docs.length) {
    return "לא נמצאו חוות דעת רפואיות בתיק.";
  }
  return docs
    .map((doc, index) => {
      const summary = truncateForPrompt(doc.extractedText);
      return [
        `חוות דעת ${index + 1}: ${doc.originalFilename}`,
        `מזהה מסמך: ${doc.id} | הועלה ב-${new Date(doc.createdAt).toLocaleString("he-IL")}`,
        `גודל קובץ: ${formatFileSize(doc.sizeBytes)}`,
        "תוכן מסוכם:",
        summary,
      ].join("\n");
    })
    .join("\n\n");
};

const formatResolvedReferences = (items: ResolvedLiteratureItem[]) => {
  if (!items.length) {
    return "לא אותרו מאמרים רלוונטיים באופן אוטומטי.";
  }
  return items
    .map((item, index) => {
      const authors = item.authors && item.authors.length ? `מחברים: ${item.authors.join(", ")}` : "מחברים: לא זוהו";
      const sourceDoc = item.matchedCitation.sourceDocumentName
        ? `מקור בחוות דעת: ${item.matchedCitation.sourceDocumentName}`
        : undefined;
      const pieces = [
        `מקור ${index + 1}: ${item.title}`,
        sourceDoc,
        authors,
        item.journal ? `כתב עת: ${item.journal}` : undefined,
        item.year ? `שנה: ${item.year}` : undefined,
        item.abstract ? `תקציר: ${item.abstract}` : undefined,
        item.url ? `קישור: ${item.url}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      return pieces;
    })
    .join("\n\n");
};

const formatUnresolvedCitations = (items: CitationCandidate[]) => {
  if (!items.length) {
    return "אין ציטוטים שדרושים אימות נוסף.";
  }
  return items
    .map((item, index) => {
      const doc = item.sourceDocumentName ? ` (${item.sourceDocumentName})` : "";
      return `ציטוט ${index + 1}${doc}: ${item.rawText}`;
    })
    .join("\n");
};

const inferExpertSpecialty = (filename: string) => {
  const normalized = filename.toLowerCase();
  if (normalized.includes("אונקול") || normalized.includes("oncolog")) {
    return "אונקולוגיה";
  }
  if (normalized.includes("רדיולוג") || normalized.includes("radiolog")) {
    return "רדיולוגיה";
  }
  if (normalized.includes("כירורג") || normalized.includes("surgery") || normalized.includes("surgeon")) {
    return "כירורגיה";
  }
  if (normalized.includes("גסטרו") || normalized.includes("gastro")) {
    return "גסטרואנטרולוגיה";
  }
  if (normalized.includes("פתולוג")) {
    return "פתולוגיה";
  }
  return "תחום לא זוהה";
};

const buildInitialReportPrompt = (options: {
  caseName: string;
  owner: string;
  focusSummary: string;
  focusNarrative: string;
  detailedDocBlock: string;
  literatureSummaryText: string;
  unresolvedCitationsText: string;
  depthHint: string;
}) => {
  const {
    caseName,
    owner,
    focusSummary,
    focusNarrative,
    detailedDocBlock,
    literatureSummaryText,
    unresolvedCitationsText,
    depthHint,
  } = options;

  const sections: string[] = [
    "🔬 פרומפט ניתוח חוות דעת רפואיות – עומק מקסימלי עבור ההגנה.",
    "",
    "מטרה: לפרק ולנתח כל טענת מומחה תביעה עד לרמת הראיה, להשוות מול ספרות עדכנית, ולהפיק דו\"ח מפורט עבור מומחה ההגנה. השתמש בשפה רפואית-עובדתית בלבד.",
    "",
    "נתוני מסגרת:",
    `- שם תיק: ${caseName}`,
    `- בעלים: ${owner}`,
    `- נקודות פוקוס שסומנו: ${focusSummary}`,
    `- טקסט פוקוס חופשי: ${focusNarrative}`,
    "",
    "חוות דעת זמינות (חובה להתייחס לכל אחת בנפרד ולהזכירן בשמן לאורך הדו\"ח):",
    detailedDocBlock,
    "",
    "מקורות ספרות שאותרו אוטומטית (שלב אותם בסקירה או פרט מדוע אינם מתאימים):",
    literatureSummaryText,
    "",
    "ציטוטים לא אומתו:",
    unresolvedCitationsText,
    "",
    "### שלבי עבודה (לבצע לפי הסדר):",
    "1. **Stage A – מיפוי טענות**: עבור כל מומחה תביעה הפק רשימת bullet של טענותיו (למשל פספוס ממצא ב‑CT, עיכוב של X חודשים, קשר לפרוגנוזה). לכל bullet הוסף `[מקור: שם חוות הדעת / עמוד]`.",
    "2. **Stage B – ציר זמן ועובדות קליניות**: בנה כרונולוגיה מפורטת הכוללת עישון, BMI, רקע משפחתי, תלונות, בדיקות, טיפולים, תוצאות פתולוגיה וזמני עיכוב. הדגש חלונות זמן קריטיים.",
    "3. **Stage C – הצלבת טענות מול החומר**: עבור כל bullet, נתח אם הוא נתמך במסמך, האם קיימים נתונים סותרים במסמכים אחרים ומה המשמעות הפתופיזיולוגית/דיאגנוסטית (למשל האם טכנית ניתן היה לזהות גידול בהדמיה ההיא).",
    "4. **Stage D – ספרות וחומר שמצטט המומחה**: בדוק אם המאמרים שהמומחה מצטט אכן אומרים מה שהוא טוען. מצא מקורות עדכניים משלך (10–15 שנים אחרונות) והשווה. לכל מאמר ציין אם הוא תומך או סותר את הטענה.",
    "5. **Stage E – הפקת סוגיות ומילות חיפוש**: גזור סוגיות רפואיות במחלוקת (פספוס דימות, סטנדרט טיפול, עיכוב באבחון, פרוגנוזה) והצע מונחי חיפוש לכל סוגיה.",
    "6. **Stage F – דו\"ח סופי במבנה המחייב מטה.**",
    "",
    "### מבנה דו\"ח מחייב:",
    "# ניתוח מומחה + סקירת ספרות רפואית",
    "## א. סיכום עובדתי של המקרה",
    "- ציר זמן רפואי, הרגלים (עישון, אלכוהול), רקע משפחתי, תלונות עיקריות, בדיקות וטיפולים. לכל פריט הוסף `[מקור: …]`.",
    "## ב. טענות עיקריות של מומחה/מומחי התביעה",
    "- עבור כל מומחה: bulletים עם הטענה, הנתונים עליהם נשען, והערת אמינות. ציין מפורשות טענות לגבי פספוס CT/עיכוב טיפול.",
    "## ג. בדיקת הטענות מול החומר",
    "- טבלה: | מקור/מסמך | טענה מצוטטת | מה נמצא בחומר | פרשנות/בעיה רפואית | צורך בנתונים נוספים |",
    "## ד. רשימת הסוגיות הרפואיות במחלוקת",
    "- מנקודות הסוגיות להוסיף מילת מפתח קצרה (\"פספוס CT\", \"Delay\", \"Guidelines\" וכו').",
    "## ה. מילות חיפוש באנגלית",
    "- עבור כל סוגיה מסעיף ד' ציין 3–8 מונחים (Clinical / Imaging / ICD / Treatment / Study) כולל תתי-תחומים (לדוגמה: \"CT sensitivity GE junction lesion\").",
    "## ו. רשימת מאמרים רלוונטיים",
    "- טבלה: | נושא | שם המאמר | שנה | כתב עת | סיכום (2–4 משפטים) | האם תומך בטענת התביעה? | רלוונטיות | טיעון לטובת ההגנה | מקור/DOI |",
    "## ז. מסקנות רפואיות עיקריות מהספרות",
    "- לפחות 5 bullet, כל אחד עם `[מקור: מאמר]`, המציין לאיזו טענה הוא מתייחס.",
    "## ח. יישום רפואי לטובת ההגנה",
    "- טיעונים חזקים (נתון קליני + ספרות).",
    "- נקודות מסוכנות/רגישות והשלמות נדרשות (הדמיה נוספת, פתולוגיה חוזרת וכו').",
    "- מומחים משלימים שכדאי לגייס (תחום + סיבה).",
    "- 10–15 שאלות רפואיות מבוססות ספרות, מחולקות לנושאים (דימות, אונקולוגיה, פרוגנוזה, תפקוד).",
    "## ט. מילות/משפטי חיפוש מומלצים בעברית ובאנגלית",
    "- לפחות שש הצעות (עברית/אנגלית) עם מטרה קצרה לכל הצעה.",
    "## י. פערים/משימות להמשך ואיסוף מסמכים",
    "- רשימת פריטים (לדוגמה: \"איתור הדמיות המקוריות מ-19/03\", \"תיק מלא מביטוח לאומי\", \"בדיקת פתולוגיה שנייה\"), לכל אחד הסבר רפואי קצר והקשר לטענה.",
    "",
    "### הנחיות משלימות:",
    "- כל טענה או נתון חייבים להסתיים ב-`[מקור: ...]` (שם מסמך, מומחה או מאמר).",
    "- עבור כל מונח רפואי פרט פתופיזיולוגיה/טיפול/ICD-10 אם רלוונטי.",
    "- במידת הצורך הוסף `[IDEA_FOR_DIAGRAM]: ...` כדי להמחיש תהליכים.",
    "- שלב את מקורות הספרות שנמצאו אוטומטית יחד עם מקורות נוספים ובדוק אם הם אכן תומכים בטענות התביעה.",
    `- רמת הפירוט צריכה להיות ${depthHint}.`,
  ];

  return sections.join("\n");
};

const mapAiLogToEvent = (log: AiUsageLogRow): CaseActivityEvent => {
  const actionLabels: Record<string, string> = {
    "initial-report": 'דו"ח ראשוני',
    "comparison-report": 'דו"ח השוואתי',
    "literature-review": "חיפוש ספרות",
  };

  const actionLabel = actionLabels[log.action] ?? log.action;
  const statusLabel = log.status === "success" ? "הושלם" : "שגיאה";

  return {
    id: log.id,
    type: "ai-event",
    title: `${actionLabel} (${statusLabel})`,
    description: [
      log.model ? `מודל: ${log.model}` : null,
      log.duration_ms ? `משך: ${log.duration_ms}ms` : null,
      log.cost_usd ? `עלות משוערת: $${Number(log.cost_usd).toFixed(4)}` : null,
      log.error_message ? `שגיאה: ${log.error_message}` : null,
    ]
      .filter(Boolean)
      .join(" | "),
    timestamp: log.created_at,
    metadata: {
      action: log.action,
      status: log.status,
      durationMs: log.duration_ms,
      totalTokens: log.total_tokens,
      costUsd: log.cost_usd,
    },
  };
};

router.get("/", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  try {
    let query = "SELECT * FROM cases ORDER BY created_at DESC";
    const params: string[] = [];

    if (user.role !== "admin") {
      query = "SELECT * FROM cases WHERE owner = $1 ORDER BY created_at DESC";
      params.push(user.username);
    }

    const result = await pool.query<CaseDbRow>(query, params);
    const cases = result.rows.map(mapCaseRowToCaseData);
    res.json(cases);
  } catch (error) {
    console.error("Error fetching cases:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  const { id } = req.params;

  try {
    const caseRow = await getCaseRow(id);

    if (!caseRow) {
      return res.status(404).json({ message: "Case not found" });
    }

    if (!canAccessCase(user, caseRow)) {
      return res.status(403).json({ message: "Forbidden: You do not have permission to view this case." });
    }

    res.json(mapCaseRowToCaseData(caseRow));
  } catch (error) {
    console.error("Error fetching case by id:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  const { name } = req.body;

  if (!name || typeof name !== "string") {
    return res.status(400).json({ message: "Case name is required and must be a string." });
  }

  try {
    const defaultFocusOptions: FocusOptions = {
      negligence: false,
      causation: false,
      lifeExpectancy: false,
    };

    const result = await pool.query<CaseDbRow>(
      `
        INSERT INTO cases (name, owner, focus_options, focus_text, app_state)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *;
      `,
      [name.trim(), user.username, JSON.stringify(defaultFocusOptions), "", "idle"]
    );

    res.status(201).json(mapCaseRowToCaseData(result.rows[0]));
  } catch (error) {
    console.error("Error creating case:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.put("/:id", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  const { id } = req.params;
  const caseUpdates: Partial<CaseData> = req.body;

  try {
    const currentResult = await pool.query<CaseDbRow>("SELECT * FROM cases WHERE id = $1", [id]);

    if (currentResult.rows.length === 0) {
      return res.status(404).json({ message: "Case not found" });
    }

    const currentCase = currentResult.rows[0];

    if (!canAccessCase(user, currentCase)) {
      return res.status(403).json({ message: "Forbidden: You do not have permission to update this case." });
    }

    const result = await pool.query<CaseDbRow>(
      `
        UPDATE cases
        SET
          name = $1,
          focus_options = $2,
          focus_text = $3,
          initial_report = $4,
          comparison_report = $5,
          app_state = $6
        WHERE id = $7
        RETURNING *;
      `,
      [
        caseUpdates.name ?? currentCase.name,
        JSON.stringify(caseUpdates.focusOptions ?? currentCase.focus_options),
        caseUpdates.focusText ?? currentCase.focus_text,
        caseUpdates.initialReport ?? currentCase.initial_report,
        caseUpdates.comparisonReport ?? currentCase.comparison_report,
        caseUpdates.appState ?? currentCase.app_state,
        id,
      ]
    );

    res.json(mapCaseRowToCaseData(result.rows[0]));
  } catch (error) {
    console.error("Error updating case:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  const { id } = req.params;

  try {
    const existing = await pool.query<{ owner: string }>("SELECT owner FROM cases WHERE id = $1", [id]);

    if (existing.rows.length === 0) {
      return res.status(204).send();
    }

    const caseOwner = existing.rows[0];

    if (caseOwner.owner !== user.username && user.role !== "admin") {
      return res.status(403).json({ message: "Forbidden: You do not have permission to delete this case." });
    }

    await pool.query("DELETE FROM cases WHERE id = $1", [id]);
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting case:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/:id/documents", (req: Request, res: Response) => {
  uploadDocumentsMiddleware(req, res, async (middlewareError: unknown) => {
    if (middlewareError) {
      if (middlewareError instanceof MulterError) {
        if (middlewareError.code === "LIMIT_FILE_SIZE") {
          return res
            .status(400)
            .json({ message: `הקובץ גדול מדי (עד ${MAX_UPLOAD_SIZE_MB}MB לקובץ).` });
        }
        return res.status(400).json({ message: `שגיאת העלאה: ${middlewareError.message}` });
      }

      console.error("Unexpected upload error:", middlewareError);
      return res.status(500).json({ message: "שגיאה במהלך העלאת הקובץ." });
    }

    const user = requireUser(req, res);
    if (!user) {
      return;
    }

    const { id } = req.params;

    try {
      const caseRow = await getCaseRow(id);

      if (!caseRow) {
        return res.status(404).json({ message: "Case not found" });
      }

      if (!canAccessCase(user, caseRow)) {
        return res.status(403).json({ message: "Forbidden: You do not have permission to upload documents." });
      }

      const files = req.files as Express.Multer.File[] | undefined;

      if (!files || files.length === 0) {
        return res.status(400).json({ message: "No files were uploaded." });
      }

      const insertedDocuments: CaseDocument[] = [];
      const errors: string[] = [];

      for (const file of files) {
        const normalizedFilename = normalizeFilename(file.originalname);
        try {
          const docType = resolveDocumentType(file);
          if (!docType) {
            errors.push(`${normalizedFilename}: Unsupported file type. Upload PDF או DOCX בלבד.`);
            continue;
          }

          const extractedText = await extractTextFromBuffer(file);

          const insertResult = await pool.query<CaseDocumentRow>(
            `
              INSERT INTO case_documents (
                id,
                case_id,
                original_filename,
                mime_type,
                size_bytes,
                extracted_text
              )
              VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING *;
            `,
            [uuidv4(), id, normalizedFilename, file.mimetype, file.size, extractedText]
          );

          insertedDocuments.push(mapDocumentRowToDocument(insertResult.rows[0]));
        } catch (error) {
          console.error("Error processing uploaded document:", error);
          errors.push(`${normalizedFilename}: Failed to process file.`);
        }
      }

      const statusCode = insertedDocuments.length > 0 ? 201 : 400;
      res.status(statusCode).json({
        documents: insertedDocuments.map(summarizeDocument),
        errors: errors.length ? errors : undefined,
      });
    } catch (error) {
      console.error("Error uploading documents:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });
});

router.get("/:id/documents", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  const { id } = req.params;

  try {
    const caseRow = await getCaseRow(id);

    if (!caseRow) {
      return res.status(404).json({ message: "Case not found" });
    }

    if (!canAccessCase(user, caseRow)) {
      return res.status(403).json({ message: "Forbidden: You do not have permission to view documents for this case." });
    }

    const documents = await getCaseDocuments(id);
    res.json(documents.map(summarizeDocument));
  } catch (error) {
    console.error("Error fetching case documents:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:id/documents/:docId", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  const { id, docId } = req.params;

  try {
    const caseRow = await getCaseRow(id);

    if (!caseRow) {
      return res.status(404).json({ message: "Case not found" });
    }

    if (!canAccessCase(user, caseRow)) {
      return res.status(403).json({ message: "Forbidden: You do not have permission to view documents for this case." });
    }

    const document = await getCaseDocumentById(id, docId);

    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }

    res.json(document);
  } catch (error) {
    console.error("Error fetching document:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.delete("/:id/documents/:docId", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  const { id, docId } = req.params;

  try {
    const caseRow = await getCaseRow(id);

    if (!caseRow) {
      return res.status(404).json({ message: "Case not found" });
    }

    if (!canAccessCase(user, caseRow)) {
      return res
        .status(403)
        .json({ message: "Forbidden: You do not have permission to delete documents for this case." });
    }

    const document = await getCaseDocumentById(id, docId);

    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }

    await pool.query("DELETE FROM case_documents WHERE id = $1 AND case_id = $2", [docId, id]);
    if (caseRow.app_state === "processing") {
      await setCaseAppState(id, "idle");
    }
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting document:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:id/activity", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  const { id } = req.params;

  try {
    const caseRow = await getCaseRow(id);

    if (!caseRow) {
      return res.status(404).json({ message: "Case not found" });
    }

    if (!canAccessCase(user, caseRow)) {
      return res.status(403).json({ message: "Forbidden: You do not have permission to view this timeline." });
    }

    const [documents, aiLogsResult] = await Promise.all([
      getCaseDocuments(id),
      pool.query<AiUsageLogRow>(
        `
          SELECT *
          FROM ai_usage_logs
          WHERE case_id = $1
          ORDER BY created_at DESC
          LIMIT 250;
        `,
        [id]
      ),
    ]);

    const events: CaseActivityEvent[] = [
      {
        id: caseRow.id,
        type: "case-created" as const,
        title: "התיק נוצר",
        description: `נוצר על ידי ${caseRow.owner}`,
        timestamp: caseRow.created_at,
        metadata: { owner: caseRow.owner },
      },
      ...documents.map((doc) => ({
        id: doc.id,
        type: "document-uploaded" as const,
        title: doc.originalFilename,
        description: `מסמך בגודל ${formatFileSize(doc.sizeBytes)}`,
        timestamp: doc.createdAt,
        metadata: {
          originalFilename: doc.originalFilename,
          sizeBytes: doc.sizeBytes,
        },
      })),
      ...aiLogsResult.rows.map(mapAiLogToEvent),
    ]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 250);

    const payload: CaseActivityResponse = {
      events,
    };

    res.json(payload);
  } catch (error) {
    console.error("Error building activity timeline:", error);
    res.status(500).json({ message: "Failed to load case activity." });
  }
});

router.post("/:id/initial-report", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  const { id } = req.params;

  try {
    const caseRow = await getCaseRow(id);

    if (!caseRow) {
      return res.status(404).json({ message: "Case not found" });
    }

    if (!canAccessCase(user, caseRow)) {
      return res.status(403).json({ message: "Forbidden: no access to generate report." });
    }

    await setCaseAppState(id, "processing");
    const documents = await getCaseDocuments(id);

    const expertOpinionDocs = documents.filter(isLikelyExpertOpinion);
    const docsForAnalysis = expertOpinionDocs.length ? expertOpinionDocs : documents;
    const detailedDocBlock = docsForAnalysis
      .map((doc, index) => {
        const specialty = inferExpertSpecialty(doc.originalFilename);
        return [
          `חוות דעת ${index + 1}: ${doc.originalFilename}`,
          `תחום מוערך: ${specialty}`,
          `מזהה מסמך: ${doc.id}`,
          `טקסט מסוכם (קרא לעומק והשתמש ישירות בניתוח):`,
          truncateForPrompt(doc.extractedText),
        ].join("\n");
      })
      .join("\n\n");

    const focusSummary = describeFocusOptions(caseRow.focus_options);
    const focusNarrative = caseRow.focus_text?.trim() ? caseRow.focus_text.trim() : "לא נמסר טקסט פוקוס.";

    const citationCandidates = docsForAnalysis.flatMap((doc) =>
      detectReferenceCandidates(doc.extractedText, {
        limit: MAX_REFERENCES_PER_DOCUMENT,
        sourceDocumentId: doc.id,
        sourceDocumentName: doc.originalFilename,
      })
    );
    const scopedCitationCandidates = citationCandidates.slice(0, MAX_REFERENCES_PER_REPORT);

    let literatureSummaryText = "לא אותרו מקורות ספרותיים באופן אוטומטי.";
    let unresolvedCitationsText = "אין ציטוטים הדורשים אימות נוסף.";

    try {
      const literatureResult = await resolveLiteratureReferences(scopedCitationCandidates);
      literatureSummaryText = formatResolvedReferences(literatureResult.resolved);
      unresolvedCitationsText = formatUnresolvedCitations(literatureResult.unresolved);
    } catch (error) {
      console.warn("Literature enrichment failed:", error);
      literatureSummaryText = "איתור המאמרים האוטומטי נכשל – אנא בצעו חיפוש ידני להצלבת מקורות.";
      unresolvedCitationsText = formatUnresolvedCitations(scopedCitationCandidates);
    }

    const prompt = buildInitialReportPrompt({
      caseName: caseRow.name,
      owner: caseRow.owner,
      focusSummary,
      focusNarrative,
      detailedDocBlock,
      literatureSummaryText,
      unresolvedCitationsText,
      depthHint: MEDICAL_REPORT_DEPTH === "concise" ? "גבוהה למרות הדרישה לתמצות" : "מעמיקה ומפורטת",
    });

    const reportText = await callOpenAI({
      messages: [
        {
          role: "system",
          content:
            "You are a senior medical expert witness who writes exhaustive Hebrew analyses of plaintiff expert opinions. Remain strictly medical; avoid legal terminology.",
        },
        { role: "user", content: prompt },
      ],
      model: MEDICAL_REPORT_MODEL,
      temperature: MEDICAL_REPORT_TEMPERATURE,
      maxTokens: INITIAL_REPORT_MAX_TOKENS,
      metadata: { caseId: id, user, action: "initial-report" },
    });

    const updateResult = await pool.query<CaseDbRow>(
      `
        UPDATE cases
        SET initial_report = $1, app_state = $2
        WHERE id = $3
        RETURNING *;
      `,
      [reportText, "idle", id]
    );

    return res.json({
      id: updateResult.rows[0].id,
      initialReport: updateResult.rows[0].initial_report,
    });
  } catch (error) {
    console.error("AI report error:", error);
    await setCaseAppState(id, "error");
    return res
      .status(500)
      .json({ message: "Failed to generate initial report", details: error instanceof Error ? error.message : undefined });
  }
});

router.post("/:id/comparison-report", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  const { id } = req.params;
  const payload: ComparisonReportRequest = req.body;

  if (!payload.reportAId || !payload.reportBId) {
    return res.status(400).json({ message: "reportAId and reportBId are required." });
  }

  try {
    const caseRow = await getCaseRow(id);

    if (!caseRow) {
      return res.status(404).json({ message: "Case not found" });
    }

    if (!canAccessCase(user, caseRow)) {
      return res.status(403).json({ message: "Forbidden: no access to generate comparison report." });
    }

    await setCaseAppState(id, "processing");

    const docA = await getCaseDocumentById(id, payload.reportAId);
    const docB = await getCaseDocumentById(id, payload.reportBId);

    if (!docA || !docB) {
      return res.status(404).json({ message: "One or both documents were not found for this case." });
    }

    const docAText = payload.reportAText ?? docA.extractedText;
    const docBText = payload.reportBText ?? docB.extractedText;

    if (!docAText || !docBText) {
      return res.status(400).json({ message: "Selected documents do not contain extracted text yet." });
    }

    const focusSummary = describeFocusOptions(caseRow.focus_options);
    const focusNarrative = caseRow.focus_text?.trim() ? caseRow.focus_text.trim() : "לא נמסר טקסט פוקוס.";

    const docABlock = [
      `חוות דעת א (${docA.originalFilename})`,
      `מזהה: ${docA.id}`,
      `תחום משוער: ${inferExpertSpecialty(docA.originalFilename)}`,
      "עיקרי הטענות והנתונים:",
      truncateForPrompt(docAText),
    ].join("\n");

    const docBBlock = [
      `חוות דעת ב (${docB.originalFilename})`,
      `מזהה: ${docB.id}`,
      `תחום משוער: ${inferExpertSpecialty(docB.originalFilename)}`,
      "עיקרי הטענות והנתונים:",
      truncateForPrompt(docBText),
    ].join("\n");

    const docACitations = detectReferenceCandidates(docAText, {
      limit: MAX_REFERENCES_PER_DOCUMENT,
      sourceDocumentId: docA.id,
      sourceDocumentName: docA.originalFilename,
    });
    const docBCitations = detectReferenceCandidates(docBText, {
      limit: MAX_REFERENCES_PER_DOCUMENT,
      sourceDocumentId: docB.id,
      sourceDocumentName: docB.originalFilename,
    });
    const combinedCitations = [...docACitations, ...docBCitations].slice(0, MAX_REFERENCES_PER_REPORT);

    let comparisonLiteratureText = "לא אותרו מקורות ספרותיים רלוונטיים באופן אוטומטי.";
    let comparisonUnresolvedText = "אין ציטוטים שדורשים בדיקה נוספת.";

    try {
      const literatureResult = await resolveLiteratureReferences(combinedCitations);
      comparisonLiteratureText = formatResolvedReferences(literatureResult.resolved);
      comparisonUnresolvedText = formatUnresolvedCitations(literatureResult.unresolved);
    } catch (error) {
      console.warn("Comparison literature enrichment failed:", error);
      comparisonLiteratureText = "איתור מקורות אוטומטי נכשל. יש להשלים חיפוש ספרות עצמאי.";
      comparisonUnresolvedText = formatUnresolvedCitations(combinedCitations);
    }

    const prompt = `
🔬 דו"ח השוואה רפואית בין מומחה התביעה (מסמך א) למומחה ההגנה (מסמך ב).

יעד: השוואה קלינית מעמיקה שמזהה מי מהשניים מציג טיעון רפואי משכנע יותר בכל סוגיה, על בסיס הנתונים בחוות הדעת והספרות העדכנית. עבודתך רפואית בלבד – אין להשתמש בשפה משפטית.

הנחות: חוות דעת א מייצגת את מומחה התביעה; חוות דעת ב מייצגת את מומחה ההגנה (באותו תחום או תחומים משיקים). אם קיימים מספר תחומי מומחיות, פצל את הניתוח בהתאם.

נתוני מסגרת:
- שם תיק: ${caseRow.name}
- נקודות פוקוס שסומנו: ${focusSummary}
- טקסט פוקוס: ${focusNarrative}

חוות דעת שנבדקות:
${docABlock}

${docBBlock}

מקורות ספרות שאותרו:
${comparisonLiteratureText}

ציטוטים לא פתורים (דורשים אימות):
${comparisonUnresolvedText}

### שלבי עבודה:
1. **מיפוי טענות** – הפק עבור כל מומחה רשימת bullet מפורטת של הטענות (פספוס דימות, עיכוב באבחון, הערכת חומרת נזק, פרוגנוזה). הוסף '[מקור: מסמך A/B]'.
2. **ניתוח נתונים** – ציין אילו ממצאים, בדיקות וספרות כל מומחה מביא. הדגש עובדות כמו עישון, רקע משפחתי, בדיקות CT ספציפיות.
3. **נקודות הסכמה ומחלוקת** – זיהוי מה מוסכם ומה שנוי במחלוקת (אבחנה, מנגנון, סטנדרט טיפול, קשר סיבתי, נזק תפקודי).
4. **בדיקת איכות הראיות** – עבור כל טענה, בדוק האם הנתונים בחומר תומכים בה, האם יש סתירות, ומה אומרים המאמרים שהם מצטטים. ציין אם יש שימוש חלקי/מוטה בספרות.
5. **ספרות עצמאית** – מצא מקורות עדכניים משלך, חבר כל מקור לסוגיה והכרע מי מהצדדים קרוב יותר לידע העדכני.
6. **הכרעה לכל סוגיה** – קבע מי משכנע יותר ולמה (התבסס על נתונים, ספרות, פתופיזיולוגיה). אם חסר מידע, הדגש מה צריך.
7. **המלצות המשך** – אילו בדיקות/חוות דעת נוספות או שאלות נדרשות למומחה ההגנה.

### מבנה דו\"ח נדרש:
📄 **תקציר לכל מומחה** – תחום, הנחות יסוד, עיקרי הנתונים.
⚖️ **טבלת הסכמות/מחלוקות** – נושא | מה אומר התובע | מה אומר ההגנה | הערכת איכות הראיות | מי משכנע.
🔍 **השוואה ביקורתית לפי תחום** – פירוט טענות, בדיקות, ספרות, וסיכום \"מי מוביל\" בכל נושא.
📚 **התאמת ספרות** – עבור כל טענה מרכזית, הצג מאמרים שחיזקו/סתרו את הצדדים (שם, שנה, כתב עת, סיכום, פסק דין האם המאמר תומך או לא).
🧠 **מסקנות רפואיות** – טיעונים חזקים של כל צד, טיעונים שההגנה יכולה למנף, נקודות תורפה של ההגנה.
❓ **שאלות למומחה ההגנה** – לפחות 10 שאלות מבוססות ספרות (דימות, פרוגנוזה, סטנדרט טיפול, עיכובים).
🧾 **מילות/משפטי חיפוש באנגלית** – 3–8 מונחים לכל סוגיה כדי להעמיק בספרות.

### הנחיות כלליות:
- כל טענה או נתון חייבים להסתיים ב-'[מקור: ...]'.
- הסבר כל מונח מקצועי ופתופיזיולוגי, במיוחד בהקשר של דימות והשלכות עיכוב בטיפול.
- אם המחשה ויזואלית תסייע, הוסף '[IDEA_FOR_DIAGRAM]: ...'.
- סיים כל סוגיה בהכרעה ברורה: "מסקנה: חוות דעת א/ב משכנעת יותר משום ש...".
`;

    const comparisonText = await callOpenAI({
      messages: [
        {
          role: "system",
          content:
            "You are a senior medical expert who compares expert opinions entirely from a clinical perspective. Always answer in Hebrew and avoid legal commentary.",
        },
        { role: "user", content: prompt },
      ],
      model: MEDICAL_REPORT_MODEL,
      temperature: MEDICAL_REPORT_TEMPERATURE,
      maxTokens: COMPARISON_REPORT_MAX_TOKENS,
      metadata: { caseId: id, user, action: "comparison-report" },
    });

    const updateResult = await pool.query<CaseDbRow>(
      `
        UPDATE cases
        SET comparison_report = $1, app_state = $2
        WHERE id = $3
        RETURNING *;
      `,
      [comparisonText, "idle", id]
    );

    return res.json({
      id: updateResult.rows[0].id,
      comparisonReport: updateResult.rows[0].comparison_report,
    });
  } catch (error) {
    console.error("Comparison report error:", error);
    await setCaseAppState(id, "error");
    return res
      .status(500)
      .json({ message: "Failed to generate comparison report", details: error instanceof Error ? error.message : undefined });
  }
});

router.post("/:id/literature-review", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  const { id } = req.params;
  const payload: LiteratureReviewRequest = req.body;

  if (!payload.clinicalQuestion || typeof payload.clinicalQuestion !== "string") {
    return res.status(400).json({ message: "clinicalQuestion is required." });
  }

  try {
    const caseRow = await getCaseRow(id);

    if (!caseRow) {
      return res.status(404).json({ message: "Case not found" });
    }

    if (!canAccessCase(user, caseRow)) {
      return res.status(403).json({ message: "Forbidden: no access to run literature review." });
    }

    const prompt = `
You are assisting defense counsel in a medical malpractice case.
Case Name: ${caseRow.name}
Clinical Question: ${payload.clinicalQuestion}
Focus Options: ${JSON.stringify(caseRow.focus_options)}
Focus Notes: ${caseRow.focus_text || "None"}

Your job is to simulate a thorough search across Israeli and international sources (including Google Scholar) and return JSON with rich details, clickable links, and explanations for every medical concept.

Return JSON with this structure:
{
  "question": "...",
  "sources": [
    {
      "title": "",
      "journal": "",
      "year": 2023,
      "url": "",
      "summary": "",
      "implication": ""
    }
  ],
  "overallSummary": "",
  "searchSuggestions": [
    "Hebrew: ...",
    "English: ..."
  ]
}

Guidelines:
- Use detailed sentences (no bullet fragments) and explain each medical concept briefly in parentheses.
- Provide at least five sources. For each source, include a clickable link (DOI if known; otherwise create a Google Scholar search link such as https://scholar.google.com/scholar?q=<encoded keywords>).
- "summary" should describe the study and key findings; "implication" should tell defense counsel how to leverage it.
- In "searchSuggestions" provide at least six combined Hebrew/English search terms or phrases derived from the uploaded case documents and AI insights.`;

    const aiResponse = await callOpenAI({
      messages: [
        { role: "system", content: "You are a medical librarian creating concise evidence summaries for legal teams." },
        { role: "user", content: prompt },
      ],
      maxTokens: 1400,
      responseFormat: { type: "json_object" },
      metadata: { caseId: id, user, action: "literature-review" },
    });

    let parsed: LiteratureReviewResult;
    try {
      parsed = JSON.parse(aiResponse) as LiteratureReviewResult;
    } catch (parseError) {
      console.warn("Failed to parse AI JSON response, returning raw text.");
      parsed = {
        question: payload.clinicalQuestion,
        sources: [],
        overallSummary: aiResponse,
        searchSuggestions: [],
      };
    }

    parsed.question = parsed.question || payload.clinicalQuestion;
    parsed.sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    parsed.overallSummary = parsed.overallSummary || "";
    parsed.searchSuggestions = Array.isArray(parsed.searchSuggestions)
      ? parsed.searchSuggestions.map((entry) => String(entry))
      : [];

    res.json(parsed);
  } catch (error) {
    console.error("Literature review error:", error);
    res
      .status(500)
      .json({ message: "Failed to generate literature review", details: error instanceof Error ? error.message : undefined });
  }
});

export default router;
