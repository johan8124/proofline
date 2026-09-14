/**
 * Focused tests for the cross-artifact supplementary_results_artifact rule.
 *
 * Covers the four implemented pieces:
 *   1. the supplementary_results_artifact rule (linked to
 *      required_file_supplementary) uses required-file presence semantics;
 *   2. the Evidence Ledger cross-artifact entry records the manuscript-rule ↔
 *      repository-artifact relationship;
 *   3. the Strands inspect_repository observation surfaces the relationship;
 *   4. the READY / BLOCKED readiness states derived from the cross-artifact
 *      evidence.
 *
 * The Strands observation test reads the committed repository fixtures
 * (read-only). All other tests are pure. Run via the built-in Node test
 * runner against the CommonJS-compiled lib (see the project README / dev
 * notes for the compile+run command).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  createEvidenceEntry,
  EXAMPLE_PDF_PAGE_COUNT_PASS,
  EXAMPLE_SUPPLEMENTARY_ARTIFACT_CROSS_LINK,
  type EvidenceEntry,
  type EvidenceLedger,
} from '../lib/evidence/evidence-ledger';
import {
  buildReadinessResult,
  readinessFindingFromEvidence,
} from '../lib/readiness/readiness-result';
import {
  EXAMPLE_MISSING_LICENSE_REPOSITORY_SNAPSHOT,
  EXAMPLE_REPOSITORY_RULES,
  EXAMPLE_SUPPLEMENTARY_RESULTS_ARTIFACT_RULE,
  validateRepositoryRule,
} from '../lib/repository/validate-repository';
import { EXAMPLE_VERIFIED_REPOSITORY_SNAPSHOT } from '../lib/repository/repository-snapshot';
import { inspectRepositoryObservation } from '../lib/agent/inspect-repository-observation';

/** Builds a deterministic passing repository evidence entry. */
function repositoryPassEvidence(
  evidenceId: string,
  ruleId: string,
  checked: string,
  value: string,
  details: string,
): EvidenceEntry {
  return createEvidenceEntry({
    evidenceId,
    ruleId,
    sourceType: 'repository',
    sourceRef: 'https://github.com/example/proofline-verified',
    checked,
    value,
    details,
    status: 'pass',
    confidence: { level: 'high', basis: 'deterministic local repository inspection' },
    timestamp: '2026-09-13T00:00:05.000Z',
    recommendedAction: 'none',
  });
}

/** Ledger in which every check passes, including the cross-artifact rule. */
const readyLedger: EvidenceLedger = {
  entries: [
    EXAMPLE_PDF_PAGE_COUNT_PASS,
    repositoryPassEvidence(
      'ev-focused-repo-accessible-pass',
      'repository_accessible',
      'repository_accessibility',
      'verified',
      "Repository accessibility reported as 'verified'.",
    ),
    repositoryPassEvidence(
      'ev-focused-repo-readme-pass',
      'required_repository_file_readme',
      'required_file:README.md',
      'present',
      "File 'README.md' reported with availability 'present'.",
    ),
    repositoryPassEvidence(
      'ev-focused-repo-license-pass',
      'required_repository_file_license',
      'required_file:LICENSE',
      'present',
      "File 'LICENSE' reported with availability 'present'.",
    ),
    EXAMPLE_SUPPLEMENTARY_ARTIFACT_CROSS_LINK,
  ],
};

/** Ledger identical to readyLedger except the cross-artifact rule fails. */
const blockedLedger: EvidenceLedger = {
  entries: [
    ...readyLedger.entries.slice(0, 4),
    {
      ...EXAMPLE_SUPPLEMENTARY_ARTIFACT_CROSS_LINK,
      evidenceId: 'ev-focused-supplementary-missing',
      checked: 'supplementary_results_artifact_missing',
      value: 'missing',
      details:
        "Repository artifact 'figures/results.pdf' was not observed; the " +
        "manuscript-side required_file_supplementary requirement is unsatisfied.",
      status: 'fail',
      recommendedAction: 'fix',
    },
  ],
};

test('supplementary_results_artifact uses required-file presence semantics and links to required_file_supplementary', () => {
  assert.equal(EXAMPLE_SUPPLEMENTARY_RESULTS_ARTIFACT_RULE.type, 'supplementary_results_artifact');
  assert.equal(
    EXAMPLE_SUPPLEMENTARY_RESULTS_ARTIFACT_RULE.linkedSubmissionRuleId,
    'required_file_supplementary',
  );

  const passResult = validateRepositoryRule(
    EXAMPLE_SUPPLEMENTARY_RESULTS_ARTIFACT_RULE,
    EXAMPLE_VERIFIED_REPOSITORY_SNAPSHOT,
  );
  assert.equal(passResult.status, 'pass');
  assert.equal(passResult.reason, 'required_file_present');
  assert.equal(passResult.ruleType, 'supplementary_results_artifact');

  const missingResult = validateRepositoryRule(
    EXAMPLE_SUPPLEMENTARY_RESULTS_ARTIFACT_RULE,
    EXAMPLE_MISSING_LICENSE_REPOSITORY_SNAPSHOT,
  );
  assert.equal(missingResult.status, 'fail');
  assert.equal(missingResult.reason, 'required_file_not_listed');
});

test('evidence ledger records the cross-artifact entry with the linked manuscript rule', () => {
  assert.equal(EXAMPLE_SUPPLEMENTARY_ARTIFACT_CROSS_LINK.ruleId, 'supplementary_results_artifact_figures_results');
  assert.equal(EXAMPLE_SUPPLEMENTARY_ARTIFACT_CROSS_LINK.checked, 'supplementary_results_artifact_present');
  assert.equal(EXAMPLE_SUPPLEMENTARY_ARTIFACT_CROSS_LINK.value, 'present');
  assert.equal(EXAMPLE_SUPPLEMENTARY_ARTIFACT_CROSS_LINK.status, 'pass');
  assert.match(EXAMPLE_SUPPLEMENTARY_ARTIFACT_CROSS_LINK.details ?? '', /required_file_supplementary/);
});

test('READY: all checks pass including the cross-artifact supplementary_results_artifact', () => {
  const findings = readyLedger.entries.map((entry) => readinessFindingFromEvidence(entry));
  const readiness = buildReadinessResult(findings, readyLedger);
  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.passedCount, 5);
  assert.equal(readiness.blockingCount, 0);
  assert.equal(readiness.humanReviewCount, 0);
});

test('BLOCKED: a missing supplementary results artifact blocks the submission', () => {
  const findings = blockedLedger.entries.map((entry) => readinessFindingFromEvidence(entry));
  const readiness = buildReadinessResult(findings, blockedLedger);
  assert.equal(readiness.status, 'blocked');
  assert.equal(readiness.passedCount, 4);
  assert.equal(readiness.blockingCount, 1);
  assert.equal(readiness.humanReviewCount, 0);

  const blocking = readiness.findings.find((finding) => finding.status === 'fail');
  assert.ok(blocking);
  assert.equal(blocking.ruleId, 'supplementary_results_artifact_figures_results');
});

test('Strands inspect_repository observes the cross-artifact relationship', async () => {
  const fixturesRoot = resolve(process.cwd(), 'test-fixtures', 'repositories');

  const complete = await inspectRepositoryObservation({
    repositoryDirectory: resolve(fixturesRoot, 'complete-repository'),
    repositoryUrl: 'https://github.com/example/proofline-verified',
  });
  assert.equal(complete.accessibility, 'verified');
  assert.equal(complete.checks.length, EXAMPLE_REPOSITORY_RULES.length);

  const artifactCheck = complete.checks.find(
    (check) => check.ruleType === 'supplementary_results_artifact',
  );
  assert.ok(artifactCheck, 'inspect_repository must observe the cross-artifact rule');
  assert.equal(artifactCheck.ruleId, 'supplementary_results_artifact_figures_results');
  assert.equal(artifactCheck.requiredPath, 'figures/results.pdf');
  assert.equal(artifactCheck.fileAvailability, 'present');
  assert.equal(artifactCheck.validationStatus, 'pass');
  assert.equal(artifactCheck.linkedSubmissionRuleId, 'required_file_supplementary');
  assert.equal(
    artifactCheck.linkedSubmissionRequirement,
    'The submission must include supplementary.pdf.',
  );

  const incomplete = await inspectRepositoryObservation({
    repositoryDirectory: resolve(fixturesRoot, 'incomplete-repository'),
    repositoryUrl: 'https://github.com/example/proofline-incomplete',
  });

  const missingCheck = incomplete.checks.find(
    (check) => check.ruleType === 'supplementary_results_artifact',
  );
  assert.ok(missingCheck, 'inspect_repository must observe the cross-artifact rule');
  assert.equal(missingCheck.validationStatus, 'fail');
  assert.equal(missingCheck.validationReason, 'required_file_not_listed');
  assert.equal(missingCheck.fileAvailability, 'missing');
  assert.equal(missingCheck.recommendedAction, 'fix');
  assert.equal(missingCheck.linkedSubmissionRuleId, 'required_file_supplementary');
});