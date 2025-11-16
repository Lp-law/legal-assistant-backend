import express, { Request, Response } from "express";
import multer, { MulterError } from "multer";
import { v4 as uuidv4 } from "uuid";
import { authMiddleware } from "../middleware/authMiddleware.js";
import pool from "../db.js";
import { extractTextFromBuffer, resolveDocumentType } from "../services/documentProcessor.js";
import { callOpenAI } from "../services/aiClient.js";
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
  },
});
const uploadDocumentsMiddleware = upload.array("files");

const DOCUMENT_PREVIEW_LENGTH = 400;
const PROMPT_DOCUMENT_CHAR_LIMIT = 6000;

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
          return res.status(400).json({ message: "הקובץ גדול מדי (עד 10MB לקובץ)." });
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
        type: "case-created",
        title: "התיק נוצר",
        description: `נוצר על ידי ${caseRow.owner}`,
        timestamp: caseRow.created_at,
        metadata: { owner: caseRow.owner },
      },
      ...documents.map((doc) => ({
        id: doc.id,
        type: "document-uploaded",
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

    const documentsContext = documents.length
      ? documents
          .map(
            (doc, index) =>
              `Document ${index + 1}: ${doc.originalFilename}\nUploaded at: ${new Date(doc.createdAt).toISOString()}\nContent:\n${truncateForPrompt(
                doc.extractedText
              )}`
          )
          .join("\n\n")
      : "No supporting documents were uploaded.";

    const focusSummary =
      Object.entries(caseRow.focus_options)
        .filter(([, enabled]) => enabled)
        .map(([key]) => key)
        .join(", ") || "None selected";

    const prompt = `
You are an experienced medical-legal analyst. Review the malpractice case information and produce a structured report for defense counsel. IMPORTANT: Write the entire report in professional Hebrew (ישראלית), including titles and sections.

Critical instructions:
1. Write as if you performed a comprehensive search across Israeli and international medical databases (כולל Google Scholar) and integrate plausible literature you would find.
2. Whenever you mention a medical/physiological term, add a short explanation in parentheses immediately after the term.
3. Use rich, detailed paragraphs—never be terse.
4. For every literature reference include a clickable URL. If you cannot provide the exact link, create a Google Scholar search link in the form https://scholar.google.com/scholar?q=<encoded keywords>.
5. Provide at least three literature sources relevant to the defense.

Case Name: ${caseRow.name}
Owner: ${caseRow.owner}
Focus Options Selected: ${focusSummary}
Focus Notes:
${caseRow.focus_text || "No additional focus text provided."}

Supporting Documents:
${documentsContext}

כתוב את הדו"ח במבנה הבא (עדיין בעברית):
1. כותרת: "ניתוח מקדמי של טענות התובע".
2. פסקת פתיחה מפורטת המבהירה את מטרת המסמך ואת היקף סריקת הספרות שבוצעה.
3. סעיף א – תקציר עמוק של המקרה והטענות המרכזיות של התובע, כולל הסבר לכל מונח רפואי.
4. סעיף ב – נקודות חולשה פוטנציאליות בטענות התובע (תתי-סעיפים לרשלנות, קשר סיבתי, נזק/תוחלת חיים) עם נימוקים רפואיים מפורטים.
5. סעיף ג – ספרות רפואית רלוונטית להגנה. עבור כל מקור ציין: שם המאמר, כתב עת, שנה, תקציר השימוש להגנה וקישור שניתן ללחוץ עליו (עדיף DOI; אחרת Google Scholar).
6. סעיף ד – הנחיות מעשיות ונקודות מיקוד למומחה ההגנה, כולל הסבר למה כל צעד חשוב.
7. סעיף ה – מידע חסר והמלצות להמשך.
8. סעיף ו – מילות/משפטי חיפוש מומלצים בעברית ובאנגלית (לפחות שש הצעות) להמשך חיפוש ספרות, מבוסס על הנתונים שבמסמכים.

הסגנון צריך להיות מקצועי, אנליטי ונייטרלי, ללא ניסוח של ייעוץ משפטי.`;

    const reportText = await callOpenAI({
      messages: [
        {
          role: "system",
          content: "You are a meticulous medical-legal analyst supporting defense counsel. Always answer in fluent Hebrew.",
        },
        { role: "user", content: prompt },
      ],
      maxTokens: 2200,
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

    const prompt = `
אתה מומחה רפואי-משפטי. השווה בין שתי חוות דעת רפואיות באותו תיק רשלנות רפואית. חשוב: כתוב את כל הדו"ח בעברית מקצועית, מעמיקה ומאוזנת.

הנחיות קריטיות:
1. התייחס כאילו ביצעת סקירה עדכנית בכל מאגרי הספרות (כולל Google Scholar) והכלל מקורות עם קישורים קליקביליים (או קישור חיפוש אם הקישור המדויק אינו ידוע).
2. עבור כל מונח רפואי או הליך, הוסף הסבר קצר בסוגריים.
3. כתוב ניתוחים ארוכים ומבוססי ראיות – בלי קיצור.
4. הוסף לפחות שלושה מקורות ספרות עם תקציר וקישור.

שם התיק: ${caseRow.name}
הערות פוקוס: ${caseRow.focus_text || "אין הערות מיוחדות"}

חוות דעת א (${docA.originalFilename}):
${truncateForPrompt(docAText)}

חוות דעת ב (${docB.originalFilename}):
${truncateForPrompt(docBText)}

בנה דו"ח בעברית עם המבנה הבא:
1. תקציר מפורט לכל חוות דעת, כולל הסבר לכל מושג רפואי.
2. נקודות הסכמה והבדלים בין חוות הדעת לפי: אבחנה, קשר סיבתי, סטנדרט טיפול, נזק/פרוגנוזה/תוחלת חיים – עם נימוקים רפואיים.
3. הערכת חוזק הראיות של כל צד (מי מסתמך על מקורות חזקים יותר ולמה) והצגת רשימת מקורות עם קישורים לחיצים.
4. המלצות אופרטיביות לצוות ההגנה – אילו נתונים לחפש, אילו שאלות להעלות, אילו מקורות ספרות לבדוק – כולל הסבר לכל נקודה.
5. מילות/משפטי חיפוש מומלצים בעברית ובאנגלית (לפחות שש הצעות) לגיבוש חיפוש ספרות ייעודי.

שמור על טון נייטרלי, אנליטי ולא משפטי.`;

    const comparisonText = await callOpenAI({
      messages: [
        {
          role: "system",
          content: "You are an impartial medical-legal analyst comparing expert opinions. Always respond in Hebrew.",
        },
        { role: "user", content: prompt },
      ],
      maxTokens: 1600,
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
