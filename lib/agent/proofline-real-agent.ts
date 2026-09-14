/**
 * Proofline real (Groq-backed) Strands agent — server-side only.
 *
 * Uses the installed Strands `OpenAIModel` against Groq's OpenAI-compatible
 * Chat Completions endpoint (openai/gpt-oss-120b). The Strands Agent remains
 * the orchestration layer; no separate OpenAI/Groq client is created here.
 *
 * SERVER ONLY: reads process.env.GROQ_API_KEY, never prints or exposes it, and
 * must never be imported from client/browser code.
 */

import {
  Agent,
  FunctionTool,
  type AgentResult,
  type JSONValue,
} from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type { EvidenceLedger } from '../evidence/evidence-ledger';
import { createEmptyLedger } from '../evidence/evidence-ledger';
import type {
  ReadinessFinding,
  ReadinessResult,
} from '../readiness/readiness-result';
import { EXAMPLE_PAGE_LIMIT_RULE } from '../rules/venue-rules';
import { verifyPdfPageLimitWithEvidence } from '../verification/verify-pdf-with-evidence';
import { verifyPdfPageLimitTool } from './proofline-verification-tools';
import { verifyLocalRepositoryTool } from './proofline-repository-tools';
import { inspectRepositoryObservation } from './inspect-repository-observation';

/** Verified Groq model id for the real agent. */
const GROQ_MODEL_ID = 'openai/gpt-oss-120b';

/** Groq OpenAI-compatible endpoint. */
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/** Environment variable that must carry the Groq API key (server-side only). */
const GROQ_API_KEY_ENV_VAR = 'GROQ_API_KEY';

/** Concise, honest system prompt for the real agent. */
const PROOFLINE_REAL_SYSTEM_PROMPT =
  "Proofline verifies research submission packages. " +
  "The agent has deterministic tools for PDF page-limit verification and local " +
  "repository verification. " +
  "Use the verification tools when the user's request requires those checks. " +
  "Do not claim a verification was performed unless a tool actually returned " +
  "the corresponding result/evidence.";

/** System prompt for the request-scoped orchestration agent. */
const PROOFLINE_ORCHESTRATION_SYSTEM_PROMPT =
  "You are Proofline's submission-preflight orchestration agent. " +
  "Your job is to inspect the supplied submission using the available tools. " +
  "Use the manuscript tool when manuscript verification is needed. " +
  "Use the repository tool when a repository is available and repository verification is relevant. " +
  "Base reasoning on actual tool observations. " +
  "Never invent verification facts. " +
  "Never invent evidence. " +
  "Never invent rule identities. " +
  "Never claim a check happened unless a tool returned an observation. " +
  "The final readiness decision will be computed separately by the deterministic Proofline pipeline and is authoritative.";

/** Task prompt for the request-scoped orchestration agent. */
const PROOFLINE_ORCHESTRATION_TASK_PROMPT =
  "Inspect this submission package using the verification tools available to you. " +
  "Begin with manuscript verification. If repository verification is available, " +
  "inspect the repository requirements as well. Summarize what you observed and " +
  "identify any unresolved or failing checks. Do not invent facts.";

/** Deterministic health check, identical to the mock-agent health_check tool. */
const healthCheckTool = new FunctionTool({
  name: 'health_check',
  description:
    'Deterministic Proofline health check. Proves the custom tool executed. Accepts no input.',
  inputSchema: { type: 'object', properties: {} },
  callback: () => ({
    status: 'ok',
    proof: 'Proofline health_check tool executed successfully',
  }),
});

/**
 * Reads and validates the Groq API key from the server environment.
 * Throws a clear error when the key is missing; never prints or exposes it.
 */
function requireGroqApiKey(): string {
  const apiKey = process.env[GROQ_API_KEY_ENV_VAR];
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('GROQ_API_KEY is required to run the real Proofline agent.');
  }
  return apiKey;
}

/** Input configuration for creating request-scoped verification tools. */
export interface RequestScopedVerificationToolsInput {
  /** Local temporary PDF file path on the server. */
  pdfFilePath: string;
  /** Optional local repository directory. */
  repositoryDirectory?: string;
  /** Optional repository URL metadata. */
  repositoryUrl?: string;
  /** Optional callback to observe tool executions (e.g. for testing / logging). */
  onToolCall?: (toolName: string, result: unknown) => void;
}

/** Result of a request-scoped agent invocation. */
export interface RequestScopedAgentRunResult {
  text: string;
  stopReason: string;
  toolsCalled: string[];
}

/**
 * Creates request-scoped FunctionTools that close over server-known values.
 * The model receives simple zero-argument tools:
 *   1. inspect_manuscript
 *   2. inspect_repository (only registered when a repository directory is provided)
 *
 * The model NEVER receives raw file paths, directory paths, evidence IDs,
 * timestamps, rule IDs, or page limits as free-form parameters.
 */
export function createRequestScopedVerificationTools(
  input: RequestScopedVerificationToolsInput,
): { tools: FunctionTool[]; toolsCalled: string[] } {
  const toolsCalled: string[] = [];

  const inspectManuscriptTool = new FunctionTool({
    name: 'inspect_manuscript',
    description:
      'Verify the submitted manuscript against the configured Example Conference ' +
      'page-limit requirement. Use this when manuscript verification is required.',
    inputSchema: { type: 'object', properties: {} },
    callback: async (): Promise<JSONValue> => {
      toolsCalled.push('inspect_manuscript');
      const timestamp = new Date().toISOString();
      const runId = Date.now().toString(36);
      const evidenceId = `ev-agent-pdf-${runId}-${EXAMPLE_PAGE_LIMIT_RULE.id}`;
      const result = await verifyPdfPageLimitWithEvidence(
        createEmptyLedger(),
        input.pdfFilePath,
        EXAMPLE_PAGE_LIMIT_RULE,
        evidenceId,
        timestamp,
      );

      const toolResult = {
        ruleId: result.evidence.ruleId,
        validationStatus: result.validation.status,
        validationReason: result.validation.reason,
        pdfInspectionStatus: result.pdfInspection.status,
        pageCount:
          result.pdfInspection.status === 'success'
            ? result.pdfInspection.pageCount
            : null,
        evidenceStatus: result.evidence.status,
        recommendedAction: result.evidence.recommendedAction,
      };

      input.onToolCall?.('inspect_manuscript', toolResult);
      return toolResult as unknown as JSONValue;
    },
  });

  const tools: FunctionTool[] = [inspectManuscriptTool];

  if (
    input.repositoryDirectory !== undefined &&
    input.repositoryDirectory.trim().length > 0 &&
    input.repositoryUrl !== undefined &&
    input.repositoryUrl.trim().length > 0
  ) {
    const repositoryDirectory = input.repositoryDirectory;
    const repositoryUrl = input.repositoryUrl;

    const inspectRepositoryTool = new FunctionTool({
      name: 'inspect_repository',
      description:
        'Inspect the supplied local repository against the Example Conference ' +
        'repository requirements.',
      inputSchema: { type: 'object', properties: {} },
      callback: async (): Promise<JSONValue> => {
        toolsCalled.push('inspect_repository');
        const observation = await inspectRepositoryObservation({
          repositoryDirectory,
          repositoryUrl,
        });
        input.onToolCall?.('inspect_repository', observation);
        return observation as unknown as JSONValue;
      },
    });

    tools.push(inspectRepositoryTool);
  }

  return { tools, toolsCalled };
}

/**
 * Constructs a request-scoped Strands Agent with safe verification tools
 * registered specifically for this preflight request.
 */
export function createRequestScopedPreflightAgent(
  input: RequestScopedVerificationToolsInput,
): { agent: Agent; toolsCalled: string[] } {
  const { tools, toolsCalled } = createRequestScopedVerificationTools(input);
  const agent = new Agent({
    model: new OpenAIModel({
      api: 'chat',
      modelId: GROQ_MODEL_ID,
      apiKey: requireGroqApiKey(),
      clientConfig: { baseURL: GROQ_BASE_URL },
    }),
    tools,
    systemPrompt: PROOFLINE_ORCHESTRATION_SYSTEM_PROMPT,
    contextManager: false,
    printer: false,
  });
  return { agent, toolsCalled };
}

/**
 * Runs the request-scoped Strands Agent, which calls verification tools and
 * reasons from the returned observations.
 */
export async function runRequestScopedPreflightAgent(
  input: RequestScopedVerificationToolsInput,
): Promise<RequestScopedAgentRunResult> {
  const { agent, toolsCalled } = createRequestScopedPreflightAgent(input);
  const agentResult: AgentResult = await agent.invoke(
    PROOFLINE_ORCHESTRATION_TASK_PROMPT,
  );
  return {
    text: agentResult.toString(),
    stopReason: agentResult.stopReason,
    toolsCalled,
  };
}

/**
 * Constructs a real Strands Agent backed by Groq (OpenAI-compatible Chat
 * Completions) with the three Proofline tools registered.
 */
export function createProoflineRealAgent(): Agent {
  return new Agent({
    model: new OpenAIModel({
      api: 'chat',
      modelId: GROQ_MODEL_ID,
      apiKey: requireGroqApiKey(),
      clientConfig: { baseURL: GROQ_BASE_URL },
    }),
    tools: [healthCheckTool, verifyPdfPageLimitTool, verifyLocalRepositoryTool],
    systemPrompt: PROOFLINE_REAL_SYSTEM_PROMPT,
    contextManager: false,
    printer: false,
  });
}

/**
 * Runs the real Proofline agent with the supplied prompt and returns a concise,
 * JSON-safe result. Never returns raw SDK objects or the API key.
 */
export async function runProoflineRealAgent(
  prompt: string,
): Promise<{ text: string; stopReason: string }> {
  const agent = createProoflineRealAgent();
  const result: AgentResult = await agent.invoke(prompt);
  return {
    text: result.toString(),
    stopReason: result.stopReason,
  };
}

/**
 * Authoritative deterministic facts handed to the explanation agent.
 * Built by the caller from the already-computed runPreflight() result —
 * never generated by the model.
 */
export interface PreflightFacts {
  /** Overall readiness status, e.g. 'ready' | 'blocked' | 'human_review'. */
  readinessStatus: string;
  /** Deterministic readiness counts from the ReadinessResult. */
  passedCount: number;
  blockingCount: number;
  humanReviewCount: number;
  /** Findings projected deterministically from the evidence ledger. */
  findings: readonly ReadinessFinding[];
  /** The immutable evidence ledger for this run. */
  evidenceLedger: EvidenceLedger;
  /** Whether the manuscript PDF was provided and verified. */
  pdfVerified: boolean;
  /** Whether the local repository was provided and verified. */
  repositoryVerified: boolean;
  /** Whether verification came from a fetched public GitHub repo, a local directory, or no repo. */
  repositorySource: 'github' | 'local' | 'none';
  /** Optional observation trace from the request-scoped orchestration agent. */
  agentInspectionObservation?: string;
}

/** System prompt for the facts-only explanation agent (no verification tools). */
const PROOFLINE_FACTS_SYSTEM_PROMPT =
  'Proofline explains already-computed deterministic submission verification. ' +
  'The caller supplies authoritative verification facts (readiness status, ' +
  'counts, findings, evidence ledger entries, verification flags, and tool inspection observations). ' +
  'Treat those supplied facts as authoritative and final. ' +
  'Do NOT perform verification yourself: do not call any verification tool, ' +
  'do not inspect files, and do not fetch URLs. ' +
  'Do NOT invent or alter verification results: never change the readiness ' +
  'status, counts, finding statuses, page counts, evidence IDs, timestamps, ' +
  'repository facts, or rule identities, and never claim a check exists that ' +
  'is not in the supplied facts. ' +
  'Do NOT output or mention server-local filesystem paths or temporary directories. ' +
  'Explain what was verified, explain why the submission has the supplied ' +
  'readiness state, identify the most important issues requiring human ' +
  'action, and recommend concrete remediation steps based ONLY on the ' +
  'supplied findings, evidence, and tool observations. ' +
  'Clearly distinguish VERIFIED FACTS (from the supplied results) from ' +
  'RECOMMENDATIONS (your advice).';

/** Headings the explanation must include so the UI can display it. */
const PROOFLINE_EXPLANATION_SECTIONS =
  'Use exactly these markdown sections in this order:\n' +
  '## Summary\n' +
  '## Verified state\n' +
  '## Issues\n' +
  '## Recommended actions';

/**
 * Sanitizes an object recursively to strip out server filesystem paths before
 * sending facts to the model. Replaces temporary file paths with their basename
 * (e.g. 'manuscript.pdf') and strips server temp directory prefixes.
 */
function sanitizeFactsForPrompt(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.toLowerCase().endsWith('.pdf') && (value.includes('/') || value.includes('\\'))) {
      const parts = value.split(/[/\\]/);
      return parts[parts.length - 1];
    }
    return value
      .replace(/[A-Za-z]:\\[^"\n\r]+\\proofline-[^"\\/\s]+/g, '[temp-dir]')
      .replace(/\/tmp\/proofline-[^"\\/\s]+/g, '[temp-dir]');
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeFactsForPrompt);
  }
  if (typeof value === 'object' && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      sanitized[k] = sanitizeFactsForPrompt(v);
    }
    return sanitized;
  }
  return value;
}

/**
 * Renders authoritative deterministic facts as the agent's user prompt.
 * Only facts/results are included — never PDF bytes, file paths on the
 * server, or secrets. JSON-serializes the supplied structures verbatim so the
 * model cannot mistake its own words for evidence.
 */
export function buildPreflightFactsPrompt(facts: PreflightFacts): string {
  const payload = {
    readinessStatus: facts.readinessStatus,
    counts: {
      passedCount: facts.passedCount,
      blockingCount: facts.blockingCount,
      humanReviewCount: facts.humanReviewCount,
    },
    findings: sanitizeFactsForPrompt(facts.findings),
    evidenceLedger: sanitizeFactsForPrompt(facts.evidenceLedger),
    pdfVerified: facts.pdfVerified,
    repositoryVerified: facts.repositoryVerified,
    repositorySource: facts.repositorySource,
    ...(facts.agentInspectionObservation !== undefined
      ? { agentToolObservations: sanitizeFactsForPrompt(facts.agentInspectionObservation) }
      : {}),
  };
  return (
    'Authoritative deterministic Proofline verification facts ' +
    '(do not alter or invent):\n' +
    JSON.stringify(payload, null, 2) +
    '\n\n' +
    PROOFLINE_EXPLANATION_SECTIONS
  );
}

/**
 * Constructs the facts-only explanation agent: same Groq model/provider, but
 * with NO verification tools registered, so it cannot re-verify or invent
 * tool results. It can only explain the supplied facts.
 */
export function createProoflineFactsAgent(): Agent {
  return new Agent({
    model: new OpenAIModel({
      api: 'chat',
      modelId: GROQ_MODEL_ID,
      apiKey: requireGroqApiKey(),
      clientConfig: { baseURL: GROQ_BASE_URL },
    }),
    tools: [],
    systemPrompt: PROOFLINE_FACTS_SYSTEM_PROMPT,
    contextManager: false,
    printer: false,
  });
}

/**
 * Explains an already-computed deterministic preflight result.
 * Backward compatible: runProoflineRealAgent(prompt) is unchanged.
 */
export async function runProoflineAgentWithFacts(
  facts: PreflightFacts,
): Promise<{ text: string; stopReason: string }> {
  const agent = createProoflineFactsAgent();
  const result: AgentResult = await agent.invoke(buildPreflightFactsPrompt(facts));
  return {
    text: result.toString(),
    stopReason: result.stopReason,
  };
}

/**
 * Builds PreflightFacts from an already-computed deterministic preflight
 * result. Pure projection — no validation logic, no model calls.
 */
export function preflightFactsFromResult(
  result: {
    readiness: ReadinessResult;
    findings: readonly ReadinessFinding[];
    evidenceLedger: EvidenceLedger;
    pdfVerified: boolean;
    repositoryVerified: boolean;
  },
  repositorySource: 'github' | 'local' | 'none',
): PreflightFacts {
  return {
    readinessStatus: result.readiness.status,
    passedCount: result.readiness.passedCount,
    blockingCount: result.readiness.blockingCount,
    humanReviewCount: result.readiness.humanReviewCount,
    findings: result.findings,
    evidenceLedger: result.evidenceLedger,
    pdfVerified: result.pdfVerified,
    repositoryVerified: result.repositoryVerified,
    repositorySource,
  };
}