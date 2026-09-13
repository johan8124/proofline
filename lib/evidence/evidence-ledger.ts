/**
 * Proofline Evidence Ledger — typed data model (foundation only).
 *
 * The Evidence Ledger records factual verification findings so a future
 * Strands agent can reason over recorded evidence instead of treating
 * model-generated text as proof.
 *
 * This module is DATA MODEL ONLY. It records evidence and verification
 * findings; it never decides whether a venue rule passes or fails (that is
 * the responsibility of lib/rules/venue-rules.ts). No Date.now(),
 * Math.random(), UUID generation, filesystem access, or network requests.
 */

/** Where a piece of evidence came from. */
export type SourceType = 'pdf' | 'repository' | 'url' | 'file' | 'manual';

/** Verification status of a recorded finding. */
export type VerificationStatus = 'pass' | 'fail' | 'unsupported' | 'needs_review';

/** Recommended follow-up action for a recorded finding. */
export type RecommendedAction = 'none' | 'fix' | 'verify' | 'human_review';

/**
 * Bounded confidence levels. Confidence is never a free-form string; the
 * optional `basis` records why the level was chosen.
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** Explicit bounded confidence representation. */
export interface EvidenceConfidence {
  /** Bounded confidence level. */
  level: ConfidenceLevel;
  /** Optional concise explanation of why this level applies. */
  basis?: string;
}

/**
 * One factual finding recorded in the Evidence Ledger.
 * All fields are supplied explicitly by the caller (deterministic; no
 * generated ids or timestamps).
 */
export interface EvidenceEntry {
  /** Unique evidence id, supplied by the caller. */
  evidenceId: string;
  /** The venue rule this evidence relates to. */
  ruleId: string;
  /** Where the evidence came from. */
  sourceType: SourceType;
  /** Reference to the concrete source (file path, URL, note id, ...). */
  sourceRef: string;
  /** What was checked (concise machine-readable description). */
  checked: string;
  /** Concise evidence value observed (e.g. '7', 'missing', 'unverified'). */
  value: string;
  /** Optional longer details about the observation. */
  details?: string;
  /** Verification status of the finding. */
  status: VerificationStatus;
  /** Bounded confidence in the finding. */
  confidence: EvidenceConfidence;
  /** ISO 8601 timestamp, supplied by the caller (deterministic in tests). */
  timestamp: string;
  /** Recommended follow-up action. */
  recommendedAction: RecommendedAction;
}

/**
 * An append-only collection of evidence entries. Entries are stored
 * read-only; ledgers are only ever replaced, never mutated.
 */
export interface EvidenceLedger {
  readonly entries: readonly EvidenceEntry[];
}

/** All fields required to create an evidence entry (everything is explicit). */
export type EvidenceEntryInput = EvidenceEntry;

/**
 * Creates an evidence entry. Pure factory: the entry is exactly the supplied
 * fields — no generated ids, timestamps, or side effects.
 */
export function createEvidenceEntry(input: EvidenceEntryInput): EvidenceEntry {
  return { ...input };
}

/** Creates a new, empty ledger. */
export function createEmptyLedger(): EvidenceLedger {
  return { entries: [] };
}

/**
 * Returns a NEW ledger containing the given entry appended to the entries
 * of the given ledger. The existing ledger (and its entries) are never
 * mutated.
 */
export function addEvidenceEntry(
  ledger: EvidenceLedger,
  entry: EvidenceEntry,
): EvidenceLedger {
  return { entries: [...ledger.entries, entry] };
}

// ---------------------------------------------------------------------------
// Deterministic examples (fixed ids and timestamps; no generated values)
// ---------------------------------------------------------------------------

/** Example 1: PDF page count passed a page-limit rule. */
export const EXAMPLE_PDF_PAGE_COUNT_PASS: EvidenceEntry = {
  evidenceId: 'ev-0001',
  ruleId: 'page_limit_max_8',
  sourceType: 'pdf',
  sourceRef: '/submissions/paper.pdf',
  checked: 'page_count',
  value: '7',
  details: 'PDF inspection reported 7 pages; limit is 8.',
  status: 'pass',
  confidence: { level: 'high', basis: 'deterministic local PDF inspection' },
  timestamp: '2026-09-13T00:00:00.000Z',
  recommendedAction: 'none',
};

/** Example 2: required file is missing. */
export const EXAMPLE_REQUIRED_FILE_MISSING: EvidenceEntry = {
  evidenceId: 'ev-0002',
  ruleId: 'required_file_supplementary',
  sourceType: 'file',
  sourceRef: 'supplementary.pdf',
  checked: 'required_file_present',
  value: 'missing',
  details: 'supplementary.pdf is not among the submission files.',
  status: 'fail',
  confidence: { level: 'high', basis: 'submission snapshot lists available files' },
  timestamp: '2026-09-13T00:00:01.000Z',
  recommendedAction: 'fix',
};

/** Example 3: URL cannot currently be verified; needs human review. */
export const EXAMPLE_URL_NEEDS_REVIEW: EvidenceEntry = {
  evidenceId: 'ev-0003',
  ruleId: 'required_url_repository',
  sourceType: 'url',
  sourceRef: 'https://example.org/proofline/repo',
  checked: 'repository_url_verified',
  value: 'unverified',
  details: 'Verification status is unknown; cannot determine pass or fail.',
  status: 'needs_review',
  confidence: { level: 'low', basis: 'no verification method available yet' },
  timestamp: '2026-09-13T00:00:02.000Z',
  recommendedAction: 'human_review',
};

/** Example ledger containing all three example entries. */
export const EXAMPLE_EVIDENCE_LEDGER: EvidenceLedger = {
  entries: [
    EXAMPLE_PDF_PAGE_COUNT_PASS,
    EXAMPLE_REQUIRED_FILE_MISSING,
    EXAMPLE_URL_NEEDS_REVIEW,
  ],
};


