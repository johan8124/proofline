/**
 * Proofline preflight — deterministic end-to-end orchestrator (Step 20).
 *
 * THIS MODULE DOES NOT CALL THE LLM. It is the single deterministic pipeline
 * that turns a local manuscript PDF and an optional local repository directory
 * into an EvidenceLedger and a ReadinessResult, using only the existing
 * Proofline modules:
 *
 *   PDF:      verifyPdfPageLimitWithEvidence()
 *             → inspect local PDF (page count) → validate page-limit rule
 *   Repo:     verifyLocalRepositoryWithEvidence() per example repository rule
 *             → inspect local directory → validate repository rule
 *   Ledger:   createEmptyLedger() + addEvidenceEntry() chain (immutable)
 *   Ready:    readinessFindingFromEvidence() + buildReadinessResult()
 *
 * Rules come from the actual exported rule constants:
 *   - EXAMPLE_PAGE_LIMIT_RULE      (lib/rules/venue-rules.ts) → 8 pages
 *   - EXAMPLE_REPOSITORY_RULES     (lib/repository/validate-repository.ts)
 * The page limit is NEVER taken from the caller or the LLM: it is whatever
 * the Example Conference rule pack exports.
 *
 * Evidence metadata (evidenceId, timestamp) is generated HERE, in the
 * application layer — it is never requested from the LLM or the caller.
 *   - timestamp: new Date().toISOString()
 *   - evidenceId: deterministic and unique within a run, derived from the
 *     run id, a per-run sequence number, and the rule id.
 *
 * Repository verification uses ONLY the existing local-directory capability
 * (inspectLocalRepository). A repository URL is accepted as recorded metadata
 * only; the module never fetches it, and it never pretends a URL alone can be
 * verified — a local directory path is required to run repository checks.
 *
 * Error policy: failures of inspection are NOT thrown — they become typed
 * 'unsupported' evidence (and therefore readiness `human_review`), exactly as
 * the underlying modules already return. Invalid orchestrator INPUT (missing
 * PDF path, inconsistent repository arguments) throws `PreflightInputError`
 * with a clear message; unexpected failures propagate to the caller.
 */

import {
  verifyPdfPageLimitWithEvidence,
} from '../verification/verify-pdf-with-evidence';
import {
  EXAMPLE_PAGE_LIMIT_RULE,
} from '../rules/venue-rules';
import {
  verifyLocalRepositoryWithEvidence,
} from '../repository/verify-local-repository-with-evidence';
import {
  EXAMPLE_REPOSITORY_RULES,
} from '../repository/validate-repository';
import {
  createEmptyLedger,
  type EvidenceLedger,
} from '../evidence/evidence-ledger';
import {
  buildReadinessResult,
  readinessFindingFromEvidence,
  type ReadinessFinding,
  type ReadinessResult,
} from '../readiness/readiness-result';

/** Inputs accepted by the deterministic preflight orchestrator. */
export interface RunPreflightInput {
  /**
   * Server-local path to the manuscript PDF. Required. The 8-page limit is
   * taken from the Example Conference rule pack — it is not configurable here.
   */
  pdfFilePath: string;
  /**
   * Server-local directory of the repository to inspect. Optional; when
   * omitted no repository checks run. The repository URL alone cannot be
   * verified by the current code.
   */
  repositoryDirectory?: string;
  /**
   * Repository URL, recorded as metadata in the snapshot/evidence. Optional.
   * If provided without `repositoryDirectory`, the orchestrator throws
   * PreflightInputError (a URL alone is not verifiable).
   */
  repositoryUrl?: string;
}

/** Structured result of one deterministic preflight run. */
export interface RunPreflightResult {
  /** Overall deterministic readiness derived from the recorded evidence. */
  readiness: ReadinessResult;
  /** Findings projected from the evidence entries (same order as evidence). */
  findings: readonly ReadinessFinding[];
  /** The complete evidence ledger for this run (never mutated after build). */
  evidenceLedger: EvidenceLedger;
  /** Whether the manuscript PDF was provided and verified. */
  pdfVerified: boolean;
  /** Whether the local repository was provided and verified. */
  repositoryVerified: boolean;
}

/** Error thrown for invalid orchestrator input (not for verification facts). */
export class PreflightInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightInputError';
  }
}

/** Ensures a non-empty string argument; throws a clear input error otherwise. */
function requireNonEmpty(value: string | undefined, label: string): void {
  if (value === undefined || value.trim().length === 0) {
    throw new PreflightInputError(`Preflight input error: ${label} must be a non-empty string.`);
  }
}

/**
 * Runs one deterministic preflight:
 *   1. verifies the manuscript PDF against the Example Conference 8-page rule
 *      and records the evidence;
 *   2. when a local repository directory is supplied, verifies every rule in
 *      the example repository rule set against that directory and records the
 *      evidence;
 *   3. assembles one immutable EvidenceLedger from all findings;
 *   4. derives the ReadinessResult from the ledger.
 *
 * Never calls the LLM. Evidence metadata is generated here.
 */
export async function runPreflight(input: RunPreflightInput): Promise<RunPreflightResult> {
  requireNonEmpty(input.pdfFilePath, 'pdfFilePath');
  if (input.repositoryUrl !== undefined && input.repositoryDirectory === undefined) {
    throw new PreflightInputError(
      'Preflight input error: repositoryUrl was provided without a local ' +
        'repositoryDirectory. A repository URL alone cannot be verified by the ' +
        'current local repository verifier.',
    );
  }
  if (input.repositoryDirectory !== undefined) {
    requireNonEmpty(input.repositoryDirectory, 'repositoryDirectory');
    requireNonEmpty(input.repositoryUrl, 'repositoryUrl');
  }

  // Application-layer evidence metadata for this run (never requested from LLM).
  const timestamp = new Date().toISOString();
  const runId = Date.now().toString(36);
  let sequence = 0;
  function nextEvidenceId(ruleId: string): string {
    sequence += 1;
    return `ev-${runId}-${sequence}-${ruleId}`;
  }

  let ledger: EvidenceLedger = createEmptyLedger();

  // 1. Manuscript PDF → Example Conference 8-page limit.
  const pdfResult = await verifyPdfPageLimitWithEvidence(
    ledger,
    input.pdfFilePath,
    EXAMPLE_PAGE_LIMIT_RULE,
    nextEvidenceId(EXAMPLE_PAGE_LIMIT_RULE.id),
    timestamp,
  );
  ledger = pdfResult.ledger;

  // 2. Local repository → every example repository rule.
  if (input.repositoryDirectory !== undefined) {
    const repositoryUrl = input.repositoryUrl as string;
    for (const rule of EXAMPLE_REPOSITORY_RULES) {
      const repoResult = await verifyLocalRepositoryWithEvidence(
        ledger,
        input.repositoryDirectory,
        repositoryUrl,
        rule,
        nextEvidenceId(rule.id),
        timestamp,
      );
      ledger = repoResult.ledger;
    }
  }

  // 3+4. Findings → ReadinessResult from the single ledger for this run.
  // The readiness result contains the authoritative (possibly deduplicated) findings.
  // Return readiness.findings as the canonical findings so all consumers get the
  // same deduplicated array.
  const findings = ledger.entries.map((entry) => readinessFindingFromEvidence(entry));
  const readiness = buildReadinessResult(findings, ledger);

  return {
    readiness,
    findings: readiness.findings,
    evidenceLedger: ledger,
    pdfVerified: true,
    repositoryVerified: input.repositoryDirectory !== undefined,
  };
}