import express, { Request, Response } from "express";
import multer, { MulterError } from "multer";
import { v4 as uuidv4 } from "uuid";
import { authMiddleware } from "../middleware/authMiddleware.js";
import pool from "../db.js";
import { extractTextFromBuffer, resolveDocumentType } from "../services/documentProcessor.js";
import { callOpenAI } from "../services/aiClient.js";
import type {
  AppState,
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
  originalFilename: row.original_filename,
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
        try {
          const docType = resolveDocumentType(file);
          if (!docType) {
            errors.push(`${file.originalname}: Unsupported file type. Upload PDF או DOCX בלבד.`);
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
            [uuidv4(), id, file.originalname, file.mimetype, file.size, extractedText]
          );

          insertedDocuments.push(mapDocumentRowToDocument(insertResult.rows[0]));
        } catch (error) {
          console.error("Error processing uploaded document:", error);
          errors.push(`${file.originalname}: Failed to process file.`);
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

Case Name: ${caseRow.name}
Owner: ${caseRow.owner}
Focus Options Selected: ${focusSummary}
Focus Notes:
${caseRow.focus_text || "No additional focus text provided."}

Supporting Documents:
${documentsContext}

כתוב את הדו"ח במבנה הבא (עדיין בעברית):
1. כותרת: "ניתוח מקדמי של טענות התובע".
2. פסקת פתיחה קצרה המבהירה את מטרת המסמך.
3. סעיף א – תקציר המקרה והטענות המרכזיות של התובע.
4. סעיף ב – נקודות חולשה פוטנציאליות בטענות התובע (תתי-סעיפים לרשלנות, קשר סיבתי, נזק/תוחלת חיים).
5. סעיף ג – ספרות רפואית רלוונטית להגנה (שם מאמר, כתב עת, שנה וקשר להגנה).
6. סעיף ד – הנחיות מעשיות ונקודות פוקוס למומחה ההגנה.
7. סעיף ה – מידע חסר והמלצות להמשך.

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
Compare the following two expert medical-legal opinions related to the same malpractice case.

Case Name: ${caseRow.name}
Focus Notes: ${caseRow.focus_text || "None"}

Opinion A (${docA.originalFilename}):
${truncateForPrompt(docAText)}

Opinion B (${docB.originalFilename}):
${truncateForPrompt(docBText)}

Produce an English report with:
1. Brief synopsis of each opinion.
2. Agreements and disagreements across: diagnosis, causation, standard of care, prognosis/life expectancy.
3. Assessment of evidentiary strength (which opinion cites stronger data and why).
4. Actionable recommendations for defense counsel (e.g., data to obtain, questions for experts, literature to consult).
Use headings, bullet points, and a neutral professional tone.`;

    const comparisonText = await callOpenAI({
      messages: [
        { role: "system", content: "You are an impartial medical-legal analyst comparing expert opinions." },
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

Provide a JSON response with the following structure:
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
  "overallSummary": ""
}

Each source should reference real or plausible peer-reviewed literature (prefer PubMed-style references) and explain how the findings help the defense.`;

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
      };
    }

    parsed.question = parsed.question || payload.clinicalQuestion;
    parsed.sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    parsed.overallSummary = parsed.overallSummary || "";

    res.json(parsed);
  } catch (error) {
    console.error("Literature review error:", error);
    res
      .status(500)
      .json({ message: "Failed to generate literature review", details: error instanceof Error ? error.message : undefined });
  }
});

export default router;
