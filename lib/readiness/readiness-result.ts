/**
 * Proofline readiness data model — pure deterministic aggregation of findings
 * and evidence into one submission readiness state.
 *
 * The readiness layer does NOT inspect PDFs or repositories and does NOT decide
 * whether a venue rule is correct. It aggregates already-produced findings and
 * evidence into a single deterministic readiness state:
 *
 *   'ready'         every supplied finding passed (no action needed)
 *   'blocked'       at least one finding failed; the submission is blocked
 *   'human_review'  nothing failed, but at least one finding is unsupported or
 *                   needs review before a pass/fail decision can be made
 *
 * Readiness- vs venue-rule status: the readiness finding status
 * ('pass' | 'fail' | 'unsupported' | 'needs_review') is intentionally wider
 * than the venue-rule `ValidationStatus` ('pass' | 'fail' | 'unsupported').
 * An `unsupported` verification is promoted to a `needs_review` readiness
 * finding so a submission is never silently marked ready when something could
 * not actually be verified.
 *
 * This module is DATA MODEL + PURE FUNCTIONS ONLY. No AI, no Strands changes,
 * no UI, no filesystem, no network, no persistence. No Date.now(),
 * Math.random(), UUIDs, or environment variables. Every id is derived from
 * the supplied evidence ids.
 */

import type {
  EvidenceEntry,
  EvidenceLedger,
  RecommendedAction,
  SourceType,
} from '../evidence/evidence-ledger';
import { createEvidenceEntry } from '../evidence/evidence-ledger';
import {
  EXAMPLE_PDF_PAGE_COUNT_PASS,
  EXAMPLE_REQUIRED_FILE_MISSING,
  EXAMPLE_URL_NEEDS_REVIEW,
} from '../evidence/evidence-ledger';

/** Overall readiness state of a submission. */
export type ReadinessStatus = 'ready' | 'blocked' | 'human_review';

/**
 * Status of a single readiness finding. Intentionally wider than the venue-
 * rule `ValidationStatus` ('pass' | 'fail' | 'unsupported'): readiness promotes
 * an unsupported verification to a human-review finding.
 */
export type ReadinessFindingStatus = 'pass' | 'fail' | 'unsupported' | 'needs_review';

/**
 * One verification finding projected into the readiness model. It is a
 * deterministic view of a single EvidenceEntry (see
 * `readinessFindingFromEvidence`) and performs no new validation logic.
 */
export interface ReadinessFinding {
  /** Stable finding id. Derived deterministically from the supplied evidence id. */
  findingId: string;
  /** The venue rule this finding relates to (from the evidence entry). */
  ruleId: string;
  /** Concise human-readable title of the finding. */
  title: string;
  /** Readiness status of the finding. */
  status: ReadinessFindingStatus;
  /** Concise machine-/human-readable explanation of the finding. */
  reason: string;
  /** Where the evidence came from ('pdf' | 'repository' | 'url' | 'file' | 'manual'). */
  sourceType: SourceType;
  /** Reference to the concrete source (file path, URL, notecard id, ...). */
  sourceRef: string;
  /** The evidence entry this finding was projected from. */
  evidenceId: string;
  /** Recommended follow-up action (from the evidence entry). */
  recommendedAction: RecommendedAction;
}

/**
 * One deterministic readiness evaluation of a submission: the derived overall
 * status, the supplied findings, the derived counts, and the associated
 * (unmutated) EvidenceLedger.
 */
export interface ReadinessResult {
  /** Overall readiness status derived from the findings. */
  status: ReadinessStatus;
  /** The supplied findings, in input order. */
  findings: readonly ReadinessFinding[];
  /** Number of findings with status 'fail'. */
  blockingCount: number;
  /** Number of findings with status 'unsupported' or 'needs_review'. */
  humanReviewCount: number;
  /** Number of findings with status 'pass'. */
  passedCount: number;
  /** The associated evidence ledger, preserved untouched. */
  evidenceLedger: EvidenceLedger;
}
/**
 * Derives the overall readiness state of a submission deterministically from
 * its supplied findings:
 *
 *   1. at least one finding with status `fail`            → 'blocked'
 *   2. otherwise at least one finding with status
 *      `unsupported` or `needs_review`                  → 'human_review'
 *   3. otherwise                                        → 'ready'
 *
 * Counts (`blockingCount` / `humanReviewCount` / `passedCount`) are derived
 * from the supplied findings. The supplied evidence ledger is returned as-is;
 * it is never mutated.
 *
 * DEDUPLICATION: When both 'required_repository_file_supplementary' and
 * 'supplementary_results_artifact_figures_results' fail together, they
 * represent the SAME underlying missing artifact (figures/results.pdf). In
 * this case, the readiness findings array contains ONE blocking finding for
 * this issue (the cross-artifact rule finding, which provides richer context),
 * and blockingCount is 1. Both evidence entries remain in the ledger
 * unchanged. This rule is intentionally narrow and does NOT apply to other
 * rule pairs.
 */
export function buildReadinessResult(
  findings: readonly ReadinessFinding[],
  evidenceLedger: EvidenceLedger,
): ReadinessResult {
  // Identify findings that fail for the specific paired case:
  // required_repository_file_supplementary + supplementary_results_artifact_figures_results
  // Both verify the same repository artifact (figures/results.pdf), so when both
  // fail they represent ONE underlying issue, not two.
  const hasRequiredSupplementaryFileFail = findings.some(
    (f) => f.status === 'fail' && f.ruleId === 'required_repository_file_supplementary',
  );
  const hasSupplementaryResultsArtifactFail = findings.some(
    (f) => f.status === 'fail' && f.ruleId === 'supplementary_results_artifact_figures_results',
  );

  // Deduplicate the paired case: if both rules fail, keep only the
  // cross-artifact finding (more context about the manuscript relationship)
  // and drop the required_repository_file_supplementary finding from the
  // readiness findings array. Both evidence entries remain in the ledger.
  const pairedBothFail =
    hasRequiredSupplementaryFileFail && hasSupplementaryResultsArtifactFail;

  let deduplicatedFindings: readonly ReadinessFinding[];
  if (pairedBothFail) {
    // Keep all findings except the duplicate required_repository_file_supplementary fail
    deduplicatedFindings = findings.filter(
      (f) =>
        !(f.status === 'fail' && f.ruleId === 'required_repository_file_supplementary'),
    );
  } else {
    deduplicatedFindings = findings;
  }

  // Count blocking findings from the deduplicated array
  const blockingCount = deduplicatedFindings.filter((finding) => finding.status === 'fail').length;
  const humanReviewCount = deduplicatedFindings.filter(
    (finding) => finding.status === 'unsupported' || finding.status === 'needs_review',
  ).length;
  const passedCount = deduplicatedFindings.filter((finding) => finding.status === 'pass').length;

  const status: ReadinessStatus =
    blockingCount > 0
      ? 'blocked'
      : humanReviewCount > 0
        ? 'human_review'
        : 'ready';

  return {
    status,
    findings: deduplicatedFindings,
    blockingCount,
    humanReviewCount,
    passedCount,
    evidenceLedger,
  };
}

/**
 * Projects one existing EvidenceEntry into a ReadinessFinding without altering
 * the evidence entry and without performing any new validation logic.
 *
 * Status mapping:
 *   evidence 'pass'          → finding 'pass'
 *   evidence 'fail'          → finding 'fail'
 *   evidence 'unsupported'   → finding 'needs_review' (unsupported cannot be
 *                               proven; readiness asks a human to review)
 *   evidence 'needs_review'  → finding 'needs_review' (preserved as-is)
 *
 * `findingId` is derived deterministically from the supplied evidence id, and
 * `evidenceId` carries the original evidence id. The concise title/reason are
 * derived from the evidence's checked/value/details fields.
 */
export function readinessFindingFromEvidence(entry: EvidenceEntry): ReadinessFinding {
  const status: ReadinessFindingStatus =
    entry.status === 'unsupported' ? 'needs_review' : entry.status;

  return {
    findingId: `finding:${entry.evidenceId}`,
    ruleId: entry.ruleId,
    title: `${entry.checked} (${entry.value})`,
    status,
    reason: entry.details ?? `${entry.checked}: observed ${entry.value}`,
    sourceType: entry.sourceType,
    sourceRef: entry.sourceRef,
    evidenceId: entry.evidenceId,
    recommendedAction: entry.recommendedAction,
  };
}

// ---------------------------------------------------------------------------
// Deterministic examples (fixed evidence ids and timestamps; no generation)
// ---------------------------------------------------------------------------

/** Deterministic unsupported evidence: a URL that cannot yet be verified. */
const EXAMPLE_UNSUPPORTED_URL_EVIDENCE: EvidenceEntry = createEvidenceEntry({
  evidenceId: 'ev-0004',
  ruleId: 'required_url_repository',
  sourceType: 'url',
  sourceRef: 'https://example.org/proofline/unsupported',
  checked: 'repository_url_verified',
  value: 'unverified',
  details: 'No verification method is available for this URL; cannot determine pass or fail.',
  status: 'unsupported',
  confidence: { level: 'low', basis: 'no verification method available' },
  timestamp: '2026-09-13T00:00:03.000Z',
  recommendedAction: 'verify',
});

/** READY example: only `pass` findings. */
export const EXAMPLE_READY_RESULT: ReadinessResult = buildReadinessResult(
  [readinessFindingFromEvidence(EXAMPLE_PDF_PAGE_COUNT_PASS)],
  { entries: [EXAMPLE_PDF_PAGE_COUNT_PASS] },
);

/** BLOCKED example: at least one `fail` finding. */
export const EXAMPLE_BLOCKED_RESULT: ReadinessResult = buildReadinessResult(
  [
    readinessFindingFromEvidence(EXAMPLE_PDF_PAGE_COUNT_PASS),
    readinessFindingFromEvidence(EXAMPLE_REQUIRED_FILE_MISSING),
  ],
  { entries: [EXAMPLE_PDF_PAGE_COUNT_PASS, EXAMPLE_REQUIRED_FILE_MISSING] },
);

/** HUMAN_REVIEW example: no failures, but unsupported/needs_review findings. */
export const EXAMPLE_HUMAN_REVIEW_RESULT: ReadinessResult = buildReadinessResult(
  [
    readinessFindingFromEvidence(EXAMPLE_PDF_PAGE_COUNT_PASS),
    readinessFindingFromEvidence(EXAMPLE_UNSUPPORTED_URL_EVIDENCE),
    readinessFindingFromEvidence(EXAMPLE_URL_NEEDS_REVIEW),
  ],
  {
    entries: [
      EXAMPLE_PDF_PAGE_COUNT_PASS,
      EXAMPLE_UNSUPPORTED_URL_EVIDENCE,
      EXAMPLE_URL_NEEDS_REVIEW,
    ],
  },
);