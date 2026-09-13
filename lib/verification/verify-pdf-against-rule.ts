/**
 * Proofline verification orchestration — connects local PDF inspection to
 * deterministic venue-rule validation.
 *
 * This module is pure orchestration. The PDF inspector remains responsible
 * only for PDF facts; the venue-rules module remains responsible only for
 * rule evaluation. No page-limit logic is duplicated here.
 */

import {
  inspectPdf,
  type PdfInspectionResult,
} from './inspect-pdf';
import {
  validateVenueRule,
  type PageLimitVenueRule,
  type SubmissionSnapshot,
  type VenueRuleValidationResult,
} from '../rules/venue-rules';

/** Re-export for downstream modules (e.g. verify-pdf-with-evidence). */
export type { PdfInspectionResult };

/** Typed result of verifying a local PDF against one page-limit rule. */
export interface PageLimitVerificationResult {
  /** The local file path that was verified. */
  filePath: string;
  /** Raw PDF inspection result (PDF facts only). */
  pdfInspection: PdfInspectionResult;
  /** Venue-rule validation result (rule evaluation only). */
  validation: VenueRuleValidationResult;
}

/**
 * Verifies a local PDF against a page-limit venue rule.
 *
 * Deterministic orchestration flow:
 *   local PDF → inspectPdf() → SubmissionSnapshot → validateVenueRule()
 *
 * If PDF inspection fails, the page count is unknown, so the validator is
 * invoked with a `pageCount: null` snapshot and returns the standard
 * 'unsupported' result — exactly as it would for any unknown page count.
 */
export async function verifyPdfAgainstPageLimit(
  filePath: string,
  rule: PageLimitVenueRule,
): Promise<PageLimitVerificationResult> {
  const pdfInspection = await inspectPdf(filePath);

  const snapshot: SubmissionSnapshot = {
    pageCount: pdfInspection.status === 'success' ? pdfInspection.pageCount : null,
    files: [],
    urls: [],
  };

  const validation = validateVenueRule(rule, snapshot);

  return { filePath, pdfInspection, validation };
}
