/**
 * Proofline verification with evidence — connects local PDF inspection,
 * page-limit rule validation, and the Evidence Ledger.
 *
 * Still NOT an AI feature. Pure deterministic orchestration:
 *   local PDF → inspectPdf → validateVenueRule → EvidenceEntry → new ledger
 *
 * The Evidence Ledger only records the finding; it never decides whether the
 * venue rule passes (that remains lib/rules/venue-rules.ts's job). The
 * supplied ledger is never mutated.
 */

import {
  verifyPdfAgainstPageLimit,
  type PdfInspectionResult,
} from './verify-pdf-against-rule';
import {
  type PageLimitVenueRule,
  type ValidationStatus,
  type VenueRuleValidationResult,
} from '../rules/venue-rules';
import {
  addEvidenceEntry,
  createEvidenceEntry,
  type EvidenceEntry,
  type EvidenceLedger,
  type RecommendedAction,
} from '../evidence/evidence-ledger';

/** Typed result of verifying a PDF page limit and recording the evidence. */
export interface PdfPageLimitEvidenceResult {
  /** The local file path that was verified. */
  filePath: string;
  /** Raw PDF inspection result (PDF facts only). */
  pdfInspection: PdfInspectionResult;
  /** Venue-rule validation result (rule evaluation only). */
  validation: VenueRuleValidationResult;
  /** The single evidence entry created for this verification. */
  evidence: EvidenceEntry;
  /** A NEW ledger containing exactly one additional entry. */
  ledger: EvidenceLedger;
}

/** Maps a validation status to the recommended follow-up action. */
function recommendedActionFor(status: ValidationStatus): RecommendedAction {
  switch (status) {
    case 'pass':
      return 'none';
    case 'fail':
      return 'fix';
    case 'unsupported':
      return 'verify';
  }
}

/** Composes details preserving why PDF inspection failed. */
function inspectionFailureDetails(pdfInspection: PdfInspectionResult): string {
  if (pdfInspection.status === 'success') {
    return '';
  }
  return (
    'PDF inspection failed: ' +
    'errorCode=' + pdfInspection.errorCode + '; ' +
    'reason=' + pdfInspection.reason + '; ' +
    'errorName=' + pdfInspection.errorName + '; ' +
    'errorMessage=' + pdfInspection.errorMessage
  );
}

/**
 * Verifies a local PDF against a page-limit venue rule and records exactly
 * one evidence entry in a new, immutably extended ledger.
 *
 * Deterministic and side-effect-free apart from reading the PDF file:
 * the supplied ledger is never mutated, and no inspection or validation
 * logic is duplicated here.
 */
export async function verifyPdfPageLimitWithEvidence(
  ledger: EvidenceLedger,
  filePath: string,
  rule: PageLimitVenueRule,
  evidenceId: string,
  timestamp: string,
): Promise<PdfPageLimitEvidenceResult> {
  const { pdfInspection, validation } = await verifyPdfAgainstPageLimit(
    filePath,
    rule,
  );

  const inspectionSucceeded = pdfInspection.status === 'success';
  const evidenceStatus = inspectionSucceeded ? validation.status : 'unsupported';

  const evidence = createEvidenceEntry({
    evidenceId,
    ruleId: rule.id,
    sourceType: 'pdf',
    sourceRef: filePath,
    checked: 'page_count',
    value: inspectionSucceeded ? String(pdfInspection.pageCount) : 'unknown',
    details: inspectionSucceeded
      ? 'PDF inspection reported ' + pdfInspection.pageCount + ' pages against limit ' + rule.expected.maxPages + '.'
      : inspectionFailureDetails(pdfInspection),
    status: evidenceStatus,
    confidence: {
      level: inspectionSucceeded ? 'high' : 'low',
      basis: inspectionSucceeded
        ? 'deterministic local PDF inspection'
        : 'PDF inspection failed; page count unavailable',
    },
    timestamp,
    recommendedAction: recommendedActionFor(evidenceStatus),
  });

  const newLedger = addEvidenceEntry(ledger, evidence);

  return { filePath, pdfInspection, validation, evidence, ledger: newLedger };
}
