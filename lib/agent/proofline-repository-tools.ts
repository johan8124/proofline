/**
 * Proofline repository tools — Strands FunctionTool adapters.
 *
 * This module contains ONLY a thin adapter that exposes Proofline's
 * deterministic local repository verification to a Strands agent as a
 * FunctionTool.
 *
 * Architecture (the adapter holds no inspection, validation, or pass/fail
 * logic):
 *   Strands FunctionTool (verify_local_repository)
 *           ↓
 *   verifyLocalRepositoryWithEvidence()  (lib/repository/verify-local-repository-with-evidence.ts)
 *           ↓
 *   inspectLocalRepository()             (lib/repository/inspect-local-repository.ts)
 *           ↓
 *   validateRepositoryRule()             (lib/repository/validate-repository.ts)
 *           ↓
 *   EvidenceEntry                        (lib/evidence/evidence-ledger.ts)
 *           ↓
 *   EvidenceLedger
 *
 * The tool result is a concise JSON-safe summary — never raw SDK objects.
 * No GitHub/API/network access. Deterministic apart from reading the local
 * directory (read-only). The orchestration function
 * verifyLocalRepositoryWithEvidence() already accepts both rule types
 * directly, so it is reused without any changes to other modules.
 */

import { FunctionTool, type JSONValue } from '@strands-agents/sdk';
import { verifyLocalRepositoryWithEvidence } from '../repository/verify-local-repository-with-evidence';
import { createEmptyLedger } from '../evidence/evidence-ledger';
import type {
  RepositoryFileCategory,
  RepositorySnapshot,
} from '../repository/repository-snapshot';
import type {
  RepositoryAccessibleRule,
  RepositoryRule,
  RepositoryRuleType,
  RequiredRepositoryFileRule,
} from '../repository/validate-repository';

/** Typed input accepted by the verify_local_repository tool. */
export interface VerifyLocalRepositoryToolInput {
  /** Local directory path of the repository to inspect. */
  directoryPath: string;
  /** Repository URL recorded in the snapshot and evidence entry. */
  repositoryUrl: string;
  /** Repository rule type to verify. */
  ruleType: RepositoryRuleType;
  /** Stable identifier for the constructed repository rule. */
  ruleId: string;
  /** Required file path (only for 'required_repository_file'). */
  requiredPath?: string;
  /** Required file category (only for 'required_repository_file'). */
  requiredCategory?: RepositoryFileCategory;
  /** Evidence id for the recorded finding (caller-supplied, deterministic). */
  evidenceId: string;
  /** ISO 8601 timestamp for the recorded finding (caller-supplied, deterministic). */
  timestamp: string;
}

/** Concise, JSON-safe result returned by the verify_local_repository tool. */
export interface VerifyLocalRepositoryToolResult {
  /** The local directory path that was inspected. */
  directoryPath: string;
  /** The repository URL recorded in the snapshot and evidence. */
  repositoryUrl: string;
  /** Identifier of the constructed repository rule. */
  ruleId: string;
  /** Type of the constructed repository rule. */
  ruleType: RepositoryRuleType;
  /** Repository-rule validation status ('pass' | 'fail' | 'unsupported'). */
  validationStatus: string;
  /** Machine-readable reason code explaining the validation status. */
  validationReason: string;
  /** Evidence id of the recorded finding. */
  evidenceId: string;
  /** Verification status recorded in the evidence entry. */
  evidenceStatus: string;
  /** Recommended follow-up action recorded in the evidence entry. */
  recommendedAction: string;
  /** Number of entries in the resulting evidence ledger (always 1 for this tool). */
  ledgerEntryCount: number;
  /** Repository accessibility observed by the local collector. */
  repositoryAccessibility: RepositorySnapshot['accessibility'];
  /** Number of files reported in the repository snapshot. */
  repositoryFileCount: number;
  /** Availability of the required file (only for 'required_repository_file'). */
  requiredFileAvailability: string | null;
  /** Category reported for the required file (only for 'required_repository_file'). */
  requiredFileCategory: string | null;
}

/** The repository file categories accepted for required_repository_file rules. */
const REPOSITORY_FILE_CATEGORIES: readonly RepositoryFileCategory[] = [
  'readme',
  'license',
  'source',
  'configuration',
  'artifact',
  'other',
];

/**
 * Builds the repository rule for the tool with fixed deterministic naming.
 * The rule identity fields (name/description) are fixed; only the supplied
 * ruleId and, for file rules, the expected path/category come from input.
 */
export function buildRepositoryRule(
  ruleType: RepositoryRuleType,
  ruleId: string,
  requiredPath?: string,
  requiredCategory?: RepositoryFileCategory,
): RepositoryRule {
  if (ruleType === 'repository_accessible') {
    const rule: RepositoryAccessibleRule = {
      id: ruleId,
      name: 'Repository accessibility',
      description: 'Repository must be accessible for verification.',
      type: 'repository_accessible',
    };
    return rule;
  }

  if (typeof requiredPath !== 'string' || requiredPath === '') {
    throw new Error(
      'verify_local_repository requires a non-empty requiredPath for ruleType required_repository_file.',
    );
  }
  if (
    requiredCategory === undefined ||
    !(REPOSITORY_FILE_CATEGORIES as readonly string[]).includes(requiredCategory)
  ) {
    throw new Error(
      'verify_local_repository requires a valid requiredCategory for ruleType required_repository_file.',
    );
  }
  const rule: RequiredRepositoryFileRule = {
    id: ruleId,
    name: 'Required repository file',
    description: 'Required repository file must be present.',
    type: 'required_repository_file',
    expected: { path: requiredPath, category: requiredCategory },
  };
  return rule;
}

/**
 * Parses and validates the raw tool input into the typed tool input.
 * Throws a plain Error (wrapped by FunctionTool into an error tool result)
 * when the input does not match the expected shape.
 */
function parseToolInput(input: unknown): VerifyLocalRepositoryToolInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('verify_local_repository expects a JSON object input.');
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.directoryPath !== 'string') {
    throw new Error('verify_local_repository requires a string directoryPath.');
  }
  if (typeof candidate.repositoryUrl !== 'string') {
    throw new Error('verify_local_repository requires a string repositoryUrl.');
  }
  if (
    candidate.ruleType !== 'repository_accessible' &&
    candidate.ruleType !== 'required_repository_file'
  ) {
    throw new Error(
      "verify_local_repository requires ruleType 'repository_accessible' or 'required_repository_file'.",
    );
  }
  if (typeof candidate.ruleId !== 'string' || candidate.ruleId === '') {
    throw new Error('verify_local_repository requires a non-empty string ruleId.');
  }
  if (candidate.requiredPath !== undefined && typeof candidate.requiredPath !== 'string') {
    throw new Error('verify_local_repository requires a string requiredPath when provided.');
  }
  if (
    candidate.requiredCategory !== undefined &&
    (typeof candidate.requiredCategory !== 'string' ||
      !(REPOSITORY_FILE_CATEGORIES as readonly string[]).includes(candidate.requiredCategory))
  ) {
    throw new Error('verify_local_repository requires a valid requiredCategory when provided.');
  }
  if (typeof candidate.evidenceId !== 'string') {
    throw new Error('verify_local_repository requires a string evidenceId.');
  }
  if (typeof candidate.timestamp !== 'string') {
    throw new Error('verify_local_repository requires a string timestamp.');
  }
  return {
    directoryPath: candidate.directoryPath,
    repositoryUrl: candidate.repositoryUrl,
    ruleType: candidate.ruleType,
    ruleId: candidate.ruleId,
    requiredPath: candidate.requiredPath,
    requiredCategory: candidate.requiredCategory as RepositoryFileCategory | undefined,
    evidenceId: candidate.evidenceId,
    timestamp: candidate.timestamp,
  };
}

/**
 * The Proofline repository verification tool: inspects a local repository
 * directory, verifies one repository rule against the resulting snapshot,
 * and records the finding as evidence.
 *
 * THIN ADAPTER: it constructs the repository rule from the fixed identity
 * plus the supplied rule id and (for file rules) expected path/category,
 * creates the initial empty EvidenceLedger internally, and delegates all
 * inspection, validation, and evidence work to
 * verifyLocalRepositoryWithEvidence().
 */
export const verifyLocalRepositoryTool = new FunctionTool({
  name: 'verify_local_repository',
  description:
    'Deterministically inspects a local repository directory and verifies one ' +
    'repository rule (repository accessibility or a required repository file), ' +
    'recording the finding as evidence. Returns the validation status and ' +
    'reason, the observed repository accessibility and file availability, the ' +
    'evidence status, the recommended action, and the evidence ledger size.',
  inputSchema: {
    type: 'object',
    properties: {
      directoryPath: { type: 'string' },
      repositoryUrl: { type: 'string' },
      ruleType: {
        type: 'string',
        enum: ['repository_accessible', 'required_repository_file'],
      },
      ruleId: { type: 'string' },
      requiredPath: { type: 'string' },
      requiredCategory: {
        type: 'string',
        enum: ['readme', 'license', 'source', 'configuration', 'artifact', 'other'],
      },
      evidenceId: { type: 'string' },
      timestamp: { type: 'string' },
    },
    required: ['directoryPath', 'repositoryUrl', 'ruleType', 'ruleId', 'evidenceId', 'timestamp'],
  },
  callback: async (input: unknown): Promise<JSONValue> => {
    const { directoryPath, repositoryUrl, ruleType, ruleId, requiredPath, requiredCategory, evidenceId, timestamp } =
      parseToolInput(input);

    const rule = buildRepositoryRule(ruleType, ruleId, requiredPath, requiredCategory);
    const result = await verifyLocalRepositoryWithEvidence(
      createEmptyLedger(),
      directoryPath,
      repositoryUrl,
      rule,
      evidenceId,
      timestamp,
    );

    const snapshot = result.repositorySnapshot;
    const requiredFile =
      ruleType === 'required_repository_file' && requiredPath !== undefined
        ? snapshot.files.find((file) => file.path === requiredPath)
        : undefined;

    const toolResult: VerifyLocalRepositoryToolResult = {
      directoryPath,
      repositoryUrl,
      ruleId: result.validation.ruleId,
      ruleType: result.validation.ruleType,
      validationStatus: result.validation.status,
      validationReason: result.validation.reason,
      evidenceId: result.evidence.evidenceId,
      evidenceStatus: result.evidence.status,
      recommendedAction: result.evidence.recommendedAction,
      ledgerEntryCount: result.ledger.entries.length,
      repositoryAccessibility: snapshot.accessibility,
      repositoryFileCount: snapshot.files.length,
      requiredFileAvailability: requiredFile === undefined ? null : requiredFile.availability,
      requiredFileCategory: requiredFile === undefined ? null : requiredFile.category,
    };

    return toolResult as unknown as JSONValue;
  },
});

