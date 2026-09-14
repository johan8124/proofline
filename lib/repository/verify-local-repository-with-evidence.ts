/**
 * Proofline local repository verification with evidence — deterministic
 * orchestration.
 *
 * Connects three existing modules without duplicating any of their logic:
 *
 *   inspectLocalRepository()        (lib/repository/inspect-local-repository.ts)
 *           ↓  RepositorySnapshot
 *   validateRepositoryRule()        (lib/repository/validate-repository.ts)
 *           ↓  RepositoryRuleValidationResult
 *   createEvidenceEntry()           (lib/evidence/evidence-ledger.ts)
 *           ↓  EvidenceEntry
 *   addEvidenceEntry()              (lib/evidence/evidence-ledger.ts)
 *           ↓  new EvidenceLedger
 *
 * The Evidence Ledger only records the finding; it never decides repository
 * rule semantics (that is validate-repository.ts's job). The supplied ledger
 * is never mutated: a NEW ledger with exactly one additional entry is
 * returned. No network, no environment access, no generated ids or
 * timestamps — evidenceId and timestamp are supplied by the caller.
 */

import {
  addEvidenceEntry,
  createEvidenceEntry,
  type ConfidenceLevel,
  type EvidenceEntry,
  type EvidenceLedger,
  type RecommendedAction,
} from '../evidence/evidence-ledger';
import type {
  RepositoryAccessibility,
  RepositoryFileAvailability,
  RepositorySnapshot,
} from './repository-snapshot';
import { inspectLocalRepository } from './inspect-local-repository';
import {
  validateRepositoryRule,
  type RepositoryRule,
  type RepositoryRuleValidationResult,
} from './validate-repository';

/** Typed result of verifying a local repository against one repository rule. */
export interface LocalRepositoryEvidenceResult {
  /** Raw repository snapshot as collected from the local directory. */
  repositorySnapshot: RepositorySnapshot;
  /** Repository-rule validation result (rule evaluation only). */
  validation: RepositoryRuleValidationResult;
  /** The single evidence entry created for this verification. */
  evidence: EvidenceEntry;
  /** A NEW ledger containing exactly one additional entry. */
  ledger: EvidenceLedger;
}

/** Maps a validation status to the recommended follow-up action. */
function recommendedActionFor(status: RepositoryRuleValidationResult['status']): RecommendedAction {
  switch (status) {
    case 'pass':
      return 'none';
    case 'fail':
      return 'fix';
    case 'unsupported':
      return 'verify';
  }
}

/**
 * Confidence follows the facts the local collector directly observed:
 * verified accessibility and present/missing file facts are high; an
 * inaccessible directory or unknown availability is low.
 */
function confidenceLevelFor(
  accessibility: RepositoryAccessibility,
  availability: RepositoryFileAvailability | undefined,
): ConfidenceLevel {
  if (accessibility !== 'verified') {
    return 'low';
  }
  return availability === 'unknown' ? 'low' : 'high';
}

/** Concise observed fact recorded in the evidence entry. */
function observedValueFor(
  rule: RepositoryRule,
  snapshot: RepositorySnapshot,
): string {
  if (rule.type === 'repository_accessible') {
    return snapshot.accessibility;
  }
  const file = snapshot.files.find((entry) => entry.path === rule.expected.path);
  return file === undefined ? 'not_listed' : file.availability;
}

/**
 * Composes details preserving why the finding holds, including the checked
 * rule, the observed snapshot fact, and the local directory inspected.
 */
function detailsFor(
  rule: RepositoryRule,
  snapshot: RepositorySnapshot,
  value: string,
  directoryPath: string,
): string {
  const inspected = `Local directory inspected: ${directoryPath}.`;
  if (rule.type === 'repository_accessible') {
    return `Repository accessibility reported as '${value}' by the local collector. ${inspected}`;
  }
  const file = snapshot.files.find((entry) => entry.path === rule.expected.path);
  const observation =
    file === undefined
      ? `No snapshot entry for '${rule.expected.path}' exists, so the file was not listed by the local inspection.`
      : `File '${rule.expected.path}' was reported with availability '${file.availability}' (category '${file.category}').`;
  return `Required repository file path '${rule.expected.path}' (expected category '${rule.expected.category}'). ${observation} ${inspected}`;
}

/**
 * Verifies a local repository directory against one repository rule and
 * records exactly one evidence entry in a new, immutably extended ledger.
 *
 * Deterministic flow (no logic duplicated from the collector, the
 * validator, or the ledger):
 *   local directory → inspectLocalRepository() → validateRepositoryRule()
 *   → createEvidenceEntry() → addEvidenceEntry()
 *
 * The supplied ledger is never mutated; apart from reading the local
 * directory (read-only) the function has no side effects.
 */
export async function verifyLocalRepositoryWithEvidence(
  ledger: EvidenceLedger,
  directoryPath: string,
  repositoryUrl: string,
  rule: RepositoryRule,
  evidenceId: string,
  timestamp: string,
): Promise<LocalRepositoryEvidenceResult> {
  const repositorySnapshot = await inspectLocalRepository(directoryPath, repositoryUrl);
  const validation = validateRepositoryRule(rule, repositorySnapshot);

  const fileAvailability =
    rule.type === 'required_repository_file' || rule.type === 'supplementary_results_artifact'
      ? repositorySnapshot.files.find((entry) => entry.path === rule.expected.path)?.availability
      : undefined;
  const confidenceLevel = confidenceLevelFor(
    repositorySnapshot.accessibility,
    fileAvailability ?? (repositorySnapshot.accessibility === 'verified' ? undefined : 'unknown'),
  );
  const observedValue = observedValueFor(rule, repositorySnapshot);

  const evidence = createEvidenceEntry({
    evidenceId,
    ruleId: rule.id,
    sourceType: 'repository',
    sourceRef: repositoryUrl,
    checked:
      rule.type === 'repository_accessible'
        ? 'repository_accessibility'
        : `required_file:${rule.expected.path}`,
    value: observedValue,
    details: detailsFor(rule, repositorySnapshot, observedValue, directoryPath),
    status: validation.status,
    confidence: {
      level: confidenceLevel,
      basis:
        confidenceLevel === 'high'
          ? 'directly observed by the deterministic local repository collector'
          : 'repository inaccessible or availability unknown; facts could not be observed',
    },
    timestamp,
    recommendedAction: recommendedActionFor(validation.status),
  });

  const newLedger = addEvidenceEntry(ledger, evidence);

  return { repositorySnapshot, validation, evidence, ledger: newLedger };
}

