/**
 * Proofline Strands inspect_repository observation builder — deterministic,
 * SDK-free.
 *
 * This module builds the exact observation payload that the request-scoped
 * Strands `inspect_repository` tool (lib/agent/proofline-real-agent.ts)
 * reports to the model. It holds NO Strands SDK logic and no pass/fail
 * decision logic: it inspects the supplied local directory once per example
 * repository rule through the existing deterministic pipeline
 * (verifyLocalRepositoryWithEvidence) and projects the results into a
 * concise, JSON-safe observation.
 *
 * Cross-artifact relationship: for `supplementary_results_artifact` checks the
 * observation carries `linkedSubmissionRuleId` / `linkedSubmissionRequirement`
 * naming the manuscript-side venue rule ('required_file_supplementary') the
 * repository artifact satisfies. Those fields are descriptive metadata from
 * the rule definition — the validation status itself comes only from the
 * deterministic required-file presence semantics.
 *
 * Separating this projection from the FunctionTool adapter keeps the
 * observation directly testable offline (no model, no SDK, no API keys).
 */

import { createEmptyLedger } from '../evidence/evidence-ledger';
import { verifyLocalRepositoryWithEvidence } from '../repository/verify-local-repository-with-evidence';
import { EXAMPLE_REPOSITORY_RULES } from '../repository/validate-repository';

/** One repository-rule check inside the inspect_repository observation. */
export interface RepositoryCheckObservation {
  ruleId: string;
  ruleType: string;
  validationStatus: string;
  validationReason: string;
  evidenceStatus: string;
  recommendedAction: string;
  /** Expected file path; present only for file-based rules. */
  requiredPath?: string;
  /** Observed availability ('present' | 'missing' | 'unknown'); file rules only. */
  fileAvailability?: string | null;
  /**
   * Manuscript-side venue rule this repository artifact satisfies; present
   * only on `supplementary_results_artifact` checks.
   */
  linkedSubmissionRuleId?: string;
  /** Human-readable description of the linked manuscript-side requirement. */
  linkedSubmissionRequirement?: string;
}

/** The JSON-safe observation payload returned by inspect_repository. */
export interface RepositoryInspectionObservation {
  repositoryUrl: string;
  accessibility: string;
  fileCount: number;
  checks: RepositoryCheckObservation[];
}

/**
 * Builds the inspect_repository observation for one local repository
 * directory. Deterministic apart from reading the local directory
 * (read-only); observation metadata (timestamp, run id) is generated here in
 * the application layer and never requested from the model.
 */
export async function inspectRepositoryObservation(input: {
  repositoryDirectory: string;
  repositoryUrl: string;
}): Promise<RepositoryInspectionObservation> {
  const timestamp = new Date().toISOString();
  const runId = Date.now().toString(36);
  let sequence = 0;

  const checks: RepositoryCheckObservation[] = [];
  let accessibility = 'unknown';
  let fileCount = 0;

  for (const rule of EXAMPLE_REPOSITORY_RULES) {
    sequence += 1;
    const evidenceId = `ev-agent-repo-${runId}-${sequence}-${rule.id}`;
    const result = await verifyLocalRepositoryWithEvidence(
      createEmptyLedger(),
      input.repositoryDirectory,
      input.repositoryUrl,
      rule,
      evidenceId,
      timestamp,
    );

    accessibility = result.repositorySnapshot.accessibility;
    fileCount = result.repositorySnapshot.files.length;
    const requiredPath =
      rule.type === 'required_repository_file' || rule.type === 'supplementary_results_artifact'
        ? rule.expected.path
        : undefined;
    const matchingFile = requiredPath
      ? result.repositorySnapshot.files.find((file) => file.path === requiredPath)
      : undefined;

    checks.push({
      ruleId: result.validation.ruleId,
      ruleType: result.validation.ruleType,
      validationStatus: result.validation.status,
      validationReason: result.validation.reason,
      evidenceStatus: result.evidence.status,
      recommendedAction: result.evidence.recommendedAction,
      ...(requiredPath
        ? {
            requiredPath,
            fileAvailability: matchingFile ? matchingFile.availability : 'missing',
          }
        : {}),
      ...(rule.type === 'supplementary_results_artifact'
        ? {
            linkedSubmissionRuleId: rule.linkedSubmissionRuleId,
            linkedSubmissionRequirement: rule.linkedSubmissionRequirement,
          }
        : {}),
    });
  }

  return {
    repositoryUrl: input.repositoryUrl,
    accessibility,
    fileCount,
    checks,
  };
}