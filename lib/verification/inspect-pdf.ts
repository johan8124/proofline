/**
 * Proofline PDF inspection — deterministic local metadata extraction.
 *
 * This module is NOT an AI feature. It inspects a supplied local PDF file
 * and returns factual metadata (currently the page count) for Proofline's
 * verification workflow. It never renders pages, performs OCR, analyzes
 * text or images, or sends the PDF anywhere.
 *
 * Uses the pdfjs-dist legacy build, as required for Node.js environments.
 */

import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Machine-readable error codes for PDF inspection failures. */
export type PdfInspectionErrorCode =
  | 'file_not_found'
  | 'file_read_failed'
  | 'invalid_pdf'
  | 'password_protected'
  | 'unexpected_error';

/** Successful inspection of a local PDF file. */
export interface PdfInspectionSuccess {
  status: 'success';
  /** The local file path that was inspected. */
  filePath: string;
  /** Number of pages reported by the PDF document structure. */
  pageCount: number;
}

/** Failed inspection of a local PDF file. */
export interface PdfInspectionFailure {
  status: 'error';
  /** The local file path that was inspected. */
  filePath: string;
  /** Concise machine-readable error code. */
  errorCode: PdfInspectionErrorCode;
  /** Concise human-readable reason. */
  reason: string;
  /** Original error class name, preserved for diagnosis. */
  errorName: string;
  /** Original error message, preserved for diagnosis. */
  errorMessage: string;
}

/** Discriminated result of inspecting a local PDF file. */
export type PdfInspectionResult = PdfInspectionSuccess | PdfInspectionFailure;

/**
 * Asynchronously inspects a local PDF file and returns its page count.
 *
 * Pure local inspection: reads only the file at `filePath`, loads it with
 * pdfjs-dist, and reads the document's page count. No rendering, no text
 * analysis, no network requests. Load and parse failures are returned as a
 * typed error result — the function does not throw.
 */
export async function inspectPdf(filePath: string): Promise<PdfInspectionResult> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(await readFile(filePath));
  } catch (error) {
    const errorCode = isErrnoCode(error, 'ENOENT') ? 'file_not_found' : 'file_read_failed';
    return failureResult(filePath, errorCode, error);
  }

  const loadingTask = getDocument({ data });
  try {
    const document = await loadingTask.promise;
    return {
      status: 'success',
      filePath,
      pageCount: document.numPages,
    };
  } catch (error) {
    return failureResult(filePath, classifyPdfjsError(error), error);
  } finally {
    // Release pdfjs resources; never masks the outcome above.
    await loadingTask.destroy();
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function classifyPdfjsError(error: unknown): PdfInspectionErrorCode {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'MissingPDFException':
      return 'file_not_found';
    case 'InvalidPDFException':
      return 'invalid_pdf';
    case 'PasswordException':
      return 'password_protected';
    default:
      return 'unexpected_error';
  }
}

function failureResult(
  filePath: string,
  errorCode: PdfInspectionErrorCode,
  error: unknown,
): PdfInspectionFailure {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    status: 'error',
    filePath,
    errorCode,
    reason: describeReason(errorCode),
    errorName: err.name,
    errorMessage: err.message,
  };
}

function describeReason(errorCode: PdfInspectionErrorCode): string {
  switch (errorCode) {
    case 'file_not_found':
      return 'The file does not exist or is not accessible.';
    case 'file_read_failed':
      return 'The file could not be read from local storage.';
    case 'invalid_pdf':
      return 'The file is not a structurally valid PDF.';
    case 'password_protected':
      return 'The PDF is password protected.';
    case 'unexpected_error':
      return 'An unexpected error occurred during PDF inspection.';
  }
}
