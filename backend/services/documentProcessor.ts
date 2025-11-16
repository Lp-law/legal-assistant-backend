import { extname } from "path";
import type { Express } from "express";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

type SupportedDocumentType = "pdf" | "docx";

const MAX_EXTRACTED_TEXT_LENGTH = 120_000;

const mimeToType: Record<string, SupportedDocumentType> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

const extensionToType: Record<string, SupportedDocumentType> = {
  ".pdf": "pdf",
  ".docx": "docx",
};

const sanitizeText = (value: string | undefined | null): string => {
  if (!value) {
    return "";
  }
  return value.replace(/\r/g, "").trim();
};

const truncateText = (value: string): string => {
  if (value.length <= MAX_EXTRACTED_TEXT_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_EXTRACTED_TEXT_LENGTH)}\n\n[Truncated for storage]`;
};

export const resolveDocumentType = (file: Express.Multer.File): SupportedDocumentType | null => {
  if (mimeToType[file.mimetype]) {
    return mimeToType[file.mimetype];
  }

  const extension = extname(file.originalname || "").toLowerCase();
  return extensionToType[extension] ?? null;
};

export const extractTextFromBuffer = async (file: Express.Multer.File): Promise<string> => {
  const docType = resolveDocumentType(file);

  if (!docType) {
    throw new Error("Unsupported file type. Please upload PDF or DOCX files only.");
  }

  if (docType === "pdf") {
    const parsed = await pdfParse(file.buffer);
    return truncateText(sanitizeText(parsed.text));
  }

  const { value } = await mammoth.extractRawText({ buffer: file.buffer });
  return truncateText(sanitizeText(value));
};

