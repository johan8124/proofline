/**
 * Proofline verification tools — Strands FunctionTool adapters.
 *
 * This module contains ONLY thin adapters that expose Proofline's
 * deterministic verification layer to a Strands agent as FunctionTools.
 *
 * Architecture (the adapter holds no inspection or validation logic):
 *   Strands FunctionTool
 *           ↓
 *   verifyPdfPageLimitWithEvidence()   (lib/verification/verify-pdf-with-evidence.ts)
 *           ↓
 *   inspectPdf()                       (lib/verification/inspect-pdf.ts)
 *           ↓
 *   validateVenueRule()                (lib/rules/venue-rules.ts)
 *           ↓
 *   EvidenceEntry                      (lib/evidence/evidence-ledger.ts)
 *           ↓
 *   EvidenceLedger
 *
 * The tool result is a concise JSON-safe summary — never the raw AgentResult
 * or complex SDK objects. Deterministic apart from the actual PDF inspection.
 */

import { FunctionTool, type JSONValue } from '@strands-agents/sdk';
import { verifyPdfPageLimitWithEvidence } from '../verification/verify-pdf-with-evidence';
import { createEmptyLedger } from '../evidence/evidence-ledger';
import type { PageLimitVenueRule } from '../rules/venue-rules';

/** Typed input accepted by the verify_pdf_page_limit tool. */
export interface VerifyPdfPageLimitToolInput {
  /** Local path of the submission PDF to verify. */
  filePath: string;
  /** Maximum page count configured for the venue. */
  maxPages: number;
  /** Evidence id for the recorded finding (caller-supplied, deterministic). */
  evidenceId: string;
  /** ISO 8601 timestamp for the recorded finding (caller-supplied, deterministic). */
  timestamp: string;
}

/** Concise, JSON-safe result returned by the verify_pdf_page_limit tool. */
export interface VerifyPdfPageLimitToolResult {
  /** Fixed identity of the page-limit rule used. */
  ruleId: string;
  /** Venue-rule validation status ('pass' | 'fail' | 'unsupported'). */
  validationStatus: string;
  /** Machine-readable reason code explaining the validation status. */
  validationReason: string;
  /** PDF inspection status ('success' | 'error'). */
  pdfInspectionStatus: string;
  /** Page count when available; null when PDF inspection failed. */
  pageCount: number | null;
  /** Evidence id of the recorded finding. */
  evidenceId: string;
  /** Verification status recorded in the evidence entry. */
  evidenceStatus: string;
  /** Recommended follow-up action recorded in the evidence entry. */
  recommendedAction: string;
  /** Number of entries in the resulting evidence ledger (always 1 for this tool). */
  ledgerEntryCount: number;
}

/** Fixed rule identity used by the verify_pdf_page_limit tool. */
const PAGE_LIMIT_RULE_ID = 'page_limit_max_pages';

/**
 * Builds the page-limit venue rule for the tool from the configured maximum.
 * The rule identity is fixed; only `maxPages` comes from the tool input.
 */
export function buildPageLimitRule(maxPages: number): PageLimitVenueRule {
  return {
    id: PAGE_LIMIT_RULE_ID,
    name: 'Maximum page count',
    description:
      'Submission PDF must not exceed the configured maximum page count.',
    type: 'page_limit',
    expected: { maxPages },
  };
}

/**
 * Parses and validates the raw tool input into the typed tool input.
 * Throws a plain Error (wrapped by FunctionTool into an error tool result)
 * when the input does not match the expected shape.
 */
function parseToolInput(input: unknown): VerifyPdfPageLimitToolInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('verify_pdf_page_limit expects a JSON object input.');
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.filePath !== 'string') {
    throw new Error('verify_pdf_page_limit requires a string filePath.');
  }
  if (typeof candidate.maxPages !== 'number' || !Number.isInteger(candidate.maxPages) || candidate.maxPages < 1) {
    throw new Error('verify_pdf_page_limit requires a positive integer maxPages.');
  }
  if (typeof candidate.evidenceId !== 'string') {
    throw new Error('verify_pdf_page_limit requires a string evidenceId.');
  }
  if (typeof candidate.timestamp !== 'string') {
    throw new Error('verify_pdf_page_limit requires a string timestamp.');
  }
  return {
    filePath: candidate.filePath,
    maxPages: candidate.maxPages,
    evidenceId: candidate.evidenceId,
    timestamp: candidate.timestamp,
  };
}

/**
 * The first real Proofline verification tool: verifies that a local
 * submission PDF does not exceed the configured maximum page count and
 * records the finding in an Evidence Ledger.
 *
 * THIN ADAPTER: it constructs the page-limit rule from the fixed identity
 * plus the configured maxPages, creates the initial empty EvidenceLedger
 * internally, and delegates all inspection, validation, and evidence work
 * to verifyPdfPageLimitWithEvidence().
 */
export const verifyPdfPageLimitTool = new FunctionTool({
  name: 'verify_pdf_page_limit',
  description:
    'Deterministically verifies that a local submission PDF does not exceed ' +
    'the configured maximum page count, and records the finding as evidence. ' +
    'Returns the validation status, PDF inspection status, page count when ' +
    'available, evidence status, and recommended action.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
      maxPages: { type: 'integer', minimum: 1 },
      evidenceId: { type: 'string' },
      timestamp: { type: 'string' },
    },
    required: ['filePath', 'maxPages', 'evidenceId', 'timestamp'],
  },
  callback: async (input: unknown): Promise<JSONValue> => {
    const { filePath, maxPages, evidenceId, timestamp } = parseToolInput(input);

    const result = await verifyPdfPageLimitWithEvidence(
      createEmptyLedger(),
      filePath,
      buildPageLimitRule(maxPages),
      evidenceId,
      timestamp,
    );

    const toolResult: VerifyPdfPageLimitToolResult = {
      ruleId: result.evidence.ruleId,
      validationStatus: result.validation.status,
      validationReason: result.validation.reason,
      pdfInspectionStatus: result.pdfInspection.status,
      pageCount:
        result.pdfInspection.status === 'success'
          ? result.pdfInspection.pageCount
          : null,
      evidenceId: result.evidence.evidenceId,
      evidenceStatus: result.evidence.status,
      recommendedAction: result.evidence.recommendedAction,
      ledgerEntryCount: result.ledger.entries.length,
    };

    return toolResult as unknown as JSONValue;
  },
});
