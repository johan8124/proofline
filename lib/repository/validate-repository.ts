/**
 * Proofline repository-rule validator — deterministic and pure.
 *
 * Evaluates repository requirements against a RepositorySnapshot whose facts
 * were already supplied by another layer. This module decides NOTHING about
 * the real world: it never calls GitHub or any URL, never inspects the
 * filesystem or repository contents, uses no AI, no environment variables,
 * no timestamps, and never mutates the snapshot.
 *
 * Repository-specific by design: it shares no logic with
 * lib/rules/venue-rules.ts (which validates submission snapshots instead).
 *
 * Evaluation semantics:
 *   repository_accessible
 *     accessibility 'verified'     → pass
 *     accessibility 'inaccessible' → fail
 *     accessibility 'unknown'      → unsupported
 *   required_repository_file (matched by exact expected path; the expected
 *     category is descriptive metadata and is never used to infer facts):
 *     matching file availability 'present' → pass
 *     matching file availability 'missing' → fail
 *     matching file availability 'unknown' → unsupported
 *     no matching file entry at all        → fail
 *   supplementary_results_artifact (cross-artifact: connects the manuscript
 *     supplementary-results requirement to a repository results artifact) uses
 *     the SAME required-file presence semantics as required_repository_file;
 *     its linkedSubmissionRuleId is descriptive metadata recording the
 *     manuscript-side rule it satisfies and is never used to infer facts.
 */

import {
  EXAMPLE_INACCESSIBLE_REPOSITORY_SNAPSHOT,
  EXAMPLE_UNKNOWN_AVAILABILITY_REPOSITORY_SNAPSHOT,
  EXAMPLE_VERIFIED_REPOSITORY_SNAPSHOT,
  type RepositoryFile,
  type RepositoryFileAvailability,
  type RepositorySnapshot,
} from './repository-snapshot';

/** Deterministic repository check categories supported by Proofline. */
export type RepositoryRuleType =
  | 'repository_accessible'
  | 'required_repository_file'
  | 'supplementary_results_artifact';

/** Validation outcome for a single repository rule against a snapshot. */
export type RepositoryValidationStatus = 'pass' | 'fail' | 'unsupported';

/** Base fields shared by every repository rule. */
export interface RepositoryRuleBase {
  /** Stable unique identifier for the rule (e.g. 'required_repository_file_readme'). */
  id: string;
  /** Human-readable requirement name. */
  name: string;
  /** Human-readable description of the requirement. */
  description: string;
}

/** Requires the repository itself to be accessible (accessibility 'verified'). */
export interface RepositoryAccessibleRule extends RepositoryRuleBase {
  type: 'repository_accessible';
}

/** Expected value for a required_repository_file rule: path plus category. */
export interface RequiredRepositoryFileExpectedValue {
  /** Repository-relative path that must be present (e.g. 'README.md'). */
  path: string;
  /** Expected coarse category of the file (descriptive; never used to infer facts). */
  category: RepositoryFile['category'];
}

/** Requires a specific file (by exact path) to be present in the repository. */
export interface RequiredRepositoryFileRule extends RepositoryRuleBase {
  type: 'required_repository_file';
  expected: RequiredRepositoryFileExpectedValue;
}

/**
 * Cross-artifact rule connecting the manuscript-side supplementary-results
 * requirement to a concrete repository results artifact. The artifact
 * presence check is identical to `required_repository_file`; the linked
 * manuscript rule id is descriptive metadata that records the cross-artifact
 * relationship in the evidence (never used to infer facts).
 */
export interface SupplementaryResultsArtifactRule extends RepositoryRuleBase {
  type: 'supplementary_results_artifact';
  /** Repository-relative expected results-artifact path (e.g. 'figures/results.pdf'). */
  expected: RequiredRepositoryFileExpectedValue;
  /**
   * Manuscript-side venue rule this repository artifact satisfies
   * (e.g. 'required_file_supplementary' from lib/rules/venue-rules.ts).
   */
  linkedSubmissionRuleId: string;
  /** Human-readable description of the linked manuscript-side requirement. */
  linkedSubmissionRequirement: string;
}

/**
 * A repository rule. A discriminated union so each rule type carries exactly
 * the expected value it needs; new check categories extend this union.
 */
export type RepositoryRule =
  | RepositoryAccessibleRule
  | RequiredRepositoryFileRule
  | SupplementaryResultsArtifactRule;

/** Machine-readable reason codes explaining a repository validation outcome. */
export type RepositoryRuleReasonCode =
  | 'repository_verified'
  | 'repository_inaccessible'
  | 'repository_accessibility_unknown'
  | 'required_file_present'
  | 'required_file_missing'
  | 'required_file_availability_unknown'
  | 'required_file_not_listed';

/** Typed result of validating one repository rule against one snapshot. */
export interface RepositoryRuleValidationResult {
  /** Identifier of the validated rule. */
  ruleId: string;
  /** Type of the validated rule. */
  ruleType: RepositoryRuleType;
  /** Validation status. */
  status: RepositoryValidationStatus;
  /** Machine-readable reason code explaining the status. */
  reason: RepositoryRuleReasonCode;
}

/**
 * Finds the snapshot file entry matching the rule's expected path, if any.
 * Pure lookup by exact path; categories are never consulted.
 */
function findFileByPath(
  snapshot: RepositorySnapshot,
  path: string,
): RepositoryFile | undefined {
  return snapshot.files.find((file) => file.path === path);
}
/** Maps a reported file availability to the matching validation outcome. */
function validateRequiredRepositoryFile(
  rule: RequiredRepositoryFileRule | SupplementaryResultsArtifactRule,
  snapshot: RepositorySnapshot,
): RepositoryRuleValidationResult {
  const file = findFileByPath(snapshot, rule.expected.path);

  let status: RepositoryValidationStatus;
  let reason: RepositoryRuleReasonCode;
  if (file === undefined) {
    status = 'fail';
    reason = 'required_file_not_listed';
  } else {
    const availability: RepositoryFileAvailability = file.availability;
    switch (availability) {
      case 'present':
        status = 'pass';
        reason = 'required_file_present';
        break;
      case 'missing':
        status = 'fail';
        reason = 'required_file_missing';
        break;
      case 'unknown':
        status = 'unsupported';
        reason = 'required_file_availability_unknown';
        break;
    }
  }

  return { ruleId: rule.id, ruleType: rule.type, status, reason };
}

/**
 * Validates one repository rule against one repository snapshot.
 * Pure and deterministic: reads the snapshot only, mutates nothing.
 */
export function validateRepositoryRule(
  rule: RepositoryRule,
  snapshot: RepositorySnapshot,
): RepositoryRuleValidationResult {
  switch (rule.type) {
    case 'repository_accessible': {
      switch (snapshot.accessibility) {
        case 'verified':
          return {
            ruleId: rule.id,
            ruleType: rule.type,
            status: 'pass',
            reason: 'repository_verified',
          };
        case 'inaccessible':
          return {
            ruleId: rule.id,
            ruleType: rule.type,
            status: 'fail',
            reason: 'repository_inaccessible',
          };
        case 'unknown':
          return {
            ruleId: rule.id,
            ruleType: rule.type,
            status: 'unsupported',
            reason: 'repository_accessibility_unknown',
          };
      }
      break; // Unreachable; exhaustive switch above.
    }
    case 'required_repository_file':
      return validateRequiredRepositoryFile(rule, snapshot);
    case 'supplementary_results_artifact':
      return validateRequiredRepositoryFile(rule, snapshot);
  }
}

/**
 * Validates a full repository rule set against one snapshot, returning one
 * result per rule in input order.
 */
export function validateRepositoryRuleSet(
  rules: readonly RepositoryRule[],
  snapshot: RepositorySnapshot,
): RepositoryRuleValidationResult[] {
  return rules.map((rule) => validateRepositoryRule(rule, snapshot));
}


// ---------------------------------------------------------------------------
// Deterministic examples (fixed values; no generated ids or timestamps)
// ---------------------------------------------------------------------------

/** Example rule 1: the repository must be accessible. */
export const EXAMPLE_REPOSITORY_ACCESSIBLE_RULE: RepositoryAccessibleRule = {
  id: 'repository_accessible',
  name: 'Repository accessible',
  description: 'The repository must be reachable and verifiable.',
  type: 'repository_accessible',
};

/** Example rule 2: a README must be present. */
export const EXAMPLE_REQUIRED_README_RULE: RequiredRepositoryFileRule = {
  id: 'required_repository_file_readme',
  name: 'README file',
  description: "The repository must include a README at 'README.md'.",
  type: 'required_repository_file',
  expected: { path: 'README.md', category: 'readme' },
};

/** Example rule 3: a LICENSE must be present. */
export const EXAMPLE_REQUIRED_LICENSE_RULE: RequiredRepositoryFileRule = {
  id: 'required_repository_file_license',
  name: 'LICENSE file',
  description: "The repository must include a license at 'LICENSE'.",
  type: 'required_repository_file',
  expected: { path: 'LICENSE', category: 'license' },
};

/** Example rule 4: a supplementary artifact must be present. */
export const EXAMPLE_REQUIRED_SUPPLEMENTARY_ARTIFACT_RULE: RequiredRepositoryFileRule = {
  id: 'required_repository_file_supplementary',
  name: 'Supplementary artifact',
  description: "The repository must include the artifact 'figures/results.pdf'.",
  type: 'required_repository_file',
  expected: { path: 'figures/results.pdf', category: 'artifact' },
};

/**
 * Example rule 5 (cross-artifact): connects the manuscript-side
 * 'required_file_supplementary' venue rule (lib/rules/venue-rules.ts) to a
 * concrete repository results artifact. The presence check is identical to
 * `required_repository_file`; `linkedSubmissionRuleId` /
 * `linkedSubmissionRequirement` are descriptive metadata recording the
 * cross-artifact relationship in the evidence and are never used to infer
 * facts.
 */
export const EXAMPLE_SUPPLEMENTARY_RESULTS_ARTIFACT_RULE: SupplementaryResultsArtifactRule = {
  id: 'supplementary_results_artifact_figures_results',
  name: 'Supplementary results artifact (cross-artifact)',
  description:
    "The repository must include the results artifact 'figures/results.pdf', " +
    'which satisfies the manuscript-side required_file_supplementary requirement.',
  type: 'supplementary_results_artifact',
  expected: { path: 'figures/results.pdf', category: 'artifact' },
  linkedSubmissionRuleId: 'required_file_supplementary',
  linkedSubmissionRequirement: 'The submission must include supplementary.pdf.',
};

/** The complete example repository rule set. */
export const EXAMPLE_REPOSITORY_RULES: readonly RepositoryRule[] = [
  EXAMPLE_REPOSITORY_ACCESSIBLE_RULE,
  EXAMPLE_REQUIRED_README_RULE,
  EXAMPLE_REQUIRED_LICENSE_RULE,
  EXAMPLE_REQUIRED_SUPPLEMENTARY_ARTIFACT_RULE,
  EXAMPLE_SUPPLEMENTARY_RESULTS_ARTIFACT_RULE,
];

/**
 * Example snapshot demonstrating a required file that is simply not listed:
 * the repository is accessible and has a README, but no LICENSE entry exists
 * at all (required_file_not_listed → fail).
 */
export const EXAMPLE_MISSING_LICENSE_REPOSITORY_SNAPSHOT: RepositorySnapshot = {
  repositoryUrl: 'https://github.com/example/proofline-missing-license',
  accessibility: 'verified',
  files: [
    { path: 'README.md', category: 'readme', availability: 'present' },
  ],
  defaultBranch: 'main',
  commitId: 'b1234567890abcdef1234567890abcdef1234567',
};

/** Passing repository: every example rule passes against the verified snapshot. */
export const EXAMPLE_PASSING_REPOSITORY_RESULTS: readonly RepositoryRuleValidationResult[] =
  validateRepositoryRuleSet(
    EXAMPLE_REPOSITORY_RULES,
    EXAMPLE_VERIFIED_REPOSITORY_SNAPSHOT,
  );

/** Inaccessible repository: accessibility and README checks both fail. */
export const EXAMPLE_INACCESSIBLE_REPOSITORY_RESULTS: readonly RepositoryRuleValidationResult[] =
  validateRepositoryRuleSet(
    [EXAMPLE_REPOSITORY_ACCESSIBLE_RULE, EXAMPLE_REQUIRED_README_RULE],
    EXAMPLE_INACCESSIBLE_REPOSITORY_SNAPSHOT,
  );

/** Missing required file: the LICENSE check fails (file not listed). */
export const EXAMPLE_MISSING_LICENSE_RESULTS: readonly RepositoryRuleValidationResult[] =
  validateRepositoryRuleSet(
    [EXAMPLE_REQUIRED_LICENSE_RULE],
    EXAMPLE_MISSING_LICENSE_REPOSITORY_SNAPSHOT,
  );

/** Unknown availability: the README and LICENSE checks are unsupported. */
export const EXAMPLE_UNKNOWN_AVAILABILITY_RESULTS: readonly RepositoryRuleValidationResult[] =
  validateRepositoryRuleSet(
    [EXAMPLE_REQUIRED_README_RULE, EXAMPLE_REQUIRED_LICENSE_RULE],
    EXAMPLE_UNKNOWN_AVAILABILITY_REPOSITORY_SNAPSHOT,
  );

