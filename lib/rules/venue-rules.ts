/**
 * Proofline venue rules — deterministic data model and pure validation.
 *
 * This module contains NO AI logic. It defines the typed representation of
 * venue requirements (rules) and submission snapshots, plus pure functions
 * that validate a snapshot against rules using only the information already
 * present in the supplied snapshot. No network, filesystem, database, or
 * environment access of any kind.
 */

/** Deterministic rule categories supported by Proofline. */
export type VenueRuleType = 'page_limit' | 'required_file' | 'required_url';

/** Validation outcome for a single rule against a submission snapshot. */
export type ValidationStatus = 'pass' | 'fail' | 'unsupported';

/** Base fields shared by every venue rule. */
export interface VenueRuleBase {
  /** Stable unique identifier for the rule (e.g. 'page_limit_max_8'). */
  id: string;
  /** Human-readable requirement name. */
  name: string;
  /** Human-readable description of the requirement. */
  description: string;
}

/** Expected value for a page_limit rule: the maximum allowed page count. */
export interface PageLimitExpectedValue {
  maxPages: number;
}

/** Expected value for a required_file rule: the file name that must be present. */
export interface RequiredFileExpectedValue {
  fileName: string;
}

/**
 * Expected value for a required_url rule: the kind of URL that must be
 * present and verified (e.g. 'repository').
 */
export interface RequiredUrlExpectedValue {
  urlKind: string;
}

export interface PageLimitVenueRule extends VenueRuleBase {
  type: 'page_limit';
  expected: PageLimitExpectedValue;
}

export interface RequiredFileVenueRule extends VenueRuleBase {
  type: 'required_file';
  expected: RequiredFileExpectedValue;
}

export interface RequiredUrlVenueRule extends VenueRuleBase {
  type: 'required_url';
  expected: RequiredUrlExpectedValue;
}

/**
 * A venue rule. A discriminated union so each rule type carries exactly the
 * expected value it needs; new categories extend this union.
 */
export type VenueRule =
  | PageLimitVenueRule
  | RequiredFileVenueRule
  | RequiredUrlVenueRule;

/** A URL recorded in a submission snapshot, with its verification status. */
export interface SubmissionSnapshotUrl {
  /** Kind of URL (e.g. 'repository'). Matched against RequiredUrlExpectedValue.urlKind. */
  kind: string;
  /** The URL string itself. Never fetched by the validator. */
  url: string;
  /**
   * Whether the URL has been verified. `null` means verification status is
   * unknown (cannot determine pass/fail for required_url rules).
   */
  verified: boolean | null;
}

/**
 * A deterministic snapshot of a submission. `null` fields mean the value is
 * unknown to Proofline, which pushes affected validations to 'unsupported'.
 */
export interface SubmissionSnapshot {
  /** Page count of the submission. `null` = unknown. */
  pageCount: number | null;
  /** File names available in the submission. */
  files: string[];
  /** URLs included in the submission, with verification status. */
  urls: SubmissionSnapshotUrl[];
}

/** Machine-readable reason codes explaining a validation outcome. */
export type VenueRuleReasonCode =
  | 'page_count_within_limit'
  | 'page_count_exceeds_limit'
  | 'page_count_unknown'
  | 'required_file_present'
  | 'required_file_missing'
  | 'required_url_verified'
  | 'required_url_unverified'
  | 'required_url_missing'
  | 'required_url_verification_unknown';

/** Typed result of validating one venue rule against one snapshot. */
export interface VenueRuleValidationResult {
  /** The id of the rule that was validated. */
  ruleId: string;
  /** The type of the rule that was validated. */
  ruleType: VenueRuleType;
  /** Outcome: pass, fail, or unsupported (cannot determine). */
  status: ValidationStatus;
  /** Concise machine-readable reason explaining the outcome. */
  reason: VenueRuleReasonCode;
}

/**
 * Validates one venue rule against one submission snapshot.
 *
 * Pure and deterministic: reads only its arguments, performs no I/O, and
 * never fetches URLs or inspects files — it validates only the information
 * already recorded in the snapshot.
 */
export function validateVenueRule(
  rule: VenueRule,
  snapshot: SubmissionSnapshot,
): VenueRuleValidationResult {
  switch (rule.type) {
    case 'page_limit': {
      const { maxPages } = rule.expected;
      if (snapshot.pageCount === null) {
        return {
          ruleId: rule.id,
          ruleType: rule.type,
          status: 'unsupported',
          reason: 'page_count_unknown',
        };
      }
      if (snapshot.pageCount > maxPages) {
        return {
          ruleId: rule.id,
          ruleType: rule.type,
          status: 'fail',
          reason: 'page_count_exceeds_limit',
        };
      }
      return {
        ruleId: rule.id,
        ruleType: rule.type,
        status: 'pass',
        reason: 'page_count_within_limit',
      };
    }
    case 'required_file': {
      const { fileName } = rule.expected;
      if (snapshot.files.includes(fileName)) {
        return {
          ruleId: rule.id,
          ruleType: rule.type,
          status: 'pass',
          reason: 'required_file_present',
        };
      }
      return {
        ruleId: rule.id,
        ruleType: rule.type,
        status: 'fail',
        reason: 'required_file_missing',
      };
    }
    case 'required_url': {
      const { urlKind } = rule.expected;
      const url = snapshot.urls.find((candidate) => candidate.kind === urlKind);
      if (url === undefined) {
        return {
          ruleId: rule.id,
          ruleType: rule.type,
          status: 'fail',
          reason: 'required_url_missing',
        };
      }
      if (url.verified === null) {
        return {
          ruleId: rule.id,
          ruleType: rule.type,
          status: 'unsupported',
          reason: 'required_url_verification_unknown',
        };
      }
      if (url.verified === false) {
        return {
          ruleId: rule.id,
          ruleType: rule.type,
          status: 'fail',
          reason: 'required_url_unverified',
        };
      }
      return {
        ruleId: rule.id,
        ruleType: rule.type,
        status: 'pass',
        reason: 'required_url_verified',
      };
    }
  }
}

/**
 * Validates a full rule set against one snapshot, returning one result per
 * rule in input order.
 */
export function validateVenueRuleSet(
  rules: readonly VenueRule[],
  snapshot: SubmissionSnapshot,
): VenueRuleValidationResult[] {
  return rules.map((rule) => validateVenueRule(rule, snapshot));
}

// ---------------------------------------------------------------------------
// Deterministic examples (for tests / local checks)
// ---------------------------------------------------------------------------

export const EXAMPLE_PAGE_LIMIT_RULE: PageLimitVenueRule = {
  id: 'page_limit_max_8',
  name: 'Maximum page count',
  description: 'The submission must not exceed 8 pages.',
  type: 'page_limit',
  expected: { maxPages: 8 },
};

export const EXAMPLE_REQUIRED_FILE_RULE: RequiredFileVenueRule = {
  id: 'required_file_supplementary',
  name: 'Supplementary material file',
  description: 'The submission must include supplementary.pdf.',
  type: 'required_file',
  expected: { fileName: 'supplementary.pdf' },
};

export const EXAMPLE_REQUIRED_URL_RULE: RequiredUrlVenueRule = {
  id: 'required_url_repository',
  name: 'Repository URL',
  description: 'The submission must include a verified repository URL.',
  type: 'required_url',
  expected: { urlKind: 'repository' },
};

/** The complete example rule set. */
export const EXAMPLE_VENUE_RULES: readonly VenueRule[] = [
  EXAMPLE_PAGE_LIMIT_RULE,
  EXAMPLE_REQUIRED_FILE_RULE,
  EXAMPLE_REQUIRED_URL_RULE,
];

/** Example snapshot that passes every rule. */
export const EXAMPLE_PASSING_SNAPSHOT: SubmissionSnapshot = {
  pageCount: 7,
  files: ['paper.pdf', 'supplementary.pdf'],
  urls: [
    { kind: 'repository', url: 'https://example.org/proofline/pass', verified: true },
  ],
};

/** Example snapshot that fails every rule. */
export const EXAMPLE_FAILING_SNAPSHOT: SubmissionSnapshot = {
  pageCount: 12,
  files: ['paper.pdf'],
  urls: [
    { kind: 'repository', url: 'https://example.org/proofline/fail', verified: false },
  ],
};

/**
 * Example snapshot Proofline cannot fully judge: the page count is unknown
 * and the repository URL is present but not yet verified.
 */
export const EXAMPLE_UNSUPPORTED_SNAPSHOT: SubmissionSnapshot = {
  pageCount: null,
  files: ['paper.pdf', 'supplementary.pdf'],
  urls: [
    { kind: 'repository', url: 'https://example.org/proofline/unknown', verified: null },
  ],
};

