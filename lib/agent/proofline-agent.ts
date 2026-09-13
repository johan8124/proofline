/**
 * Proofline Strands agent foundation — local proof with the full verification tool set.
 *
 * Proves the chain:
 *   Next.js TypeScript code → Strands Agent → three deterministic custom tools
 *   (`health_check`, `verify_pdf_page_limit`, `verify_local_repository`) → local mock
 *   model → successful local invocation.
 *
 * The mock model (`ProoflineMockModel`, see ./proofline-mock-model) guarantees
 * this runs completely offline: no Bedrock, OpenAI, Anthropic, Google, xAI,
 * or OpenRouter call, no API key, no environment variables.
 */

import {
  Agent,
  FunctionTool,
  type AgentResult,
  type JSONValue,
  type ToolResultBlock,
} from '@strands-agents/sdk';
import { ProoflineMockModel } from './proofline-mock-model';
import { verifyLocalRepositoryTool } from './proofline-repository-tools';
import { verifyPdfPageLimitTool } from './proofline-verification-tools';

/**
 * Deterministic, self-contained Proofline health check.
 * Accepts no meaningful input and always returns the same result.
 */
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

const PROOFLINE_SYSTEM_PROMPT =
  'You are the Proofline verification agent with three deterministic local tools: ' +
  'health_check (self-contained health proof), verify_pdf_page_limit (verifies that a local ' +
  'submission PDF does not exceed a configured maximum page count), and verify_local_repository ' +
  '(verifies that a local repository directory satisfies a repository accessibility or required-file ' +
  'rule). On every user message, call the health_check tool, then report the tool result verbatim.';

/** Small proof payload returned by runProoflineAgent(). */
export interface ProoflineAgentRunResult {
  /** The Agent was constructed successfully. */
  constructed: boolean;
  /** The health_check tool executed with a successful tool result. */
  toolExecuted: boolean;
  /** Final stop reason of the local invocation (expected 'endTurn'). */
  stopReason: string;
  /** Final assistant text of the local invocation. */
  text: string;
  /** Deterministic value returned by the health_check tool. */
  toolResult: JSONValue | null;
  /** The raw Strands AgentResult for further inspection. */
  agentResult: AgentResult;
}

/** Constructs the Proofline agent using the mock model and its registered tools. */
export function createProoflineAgent(): Agent {
  return new Agent({
    model: new ProoflineMockModel(),
    tools: [healthCheckTool, verifyPdfPageLimitTool, verifyLocalRepositoryTool],
    systemPrompt: PROOFLINE_SYSTEM_PROMPT,
    printer: false,
  });
}

/** Result of the local Proofline tool-registry integration check. */
export interface ProoflineToolRegistryCheck {
  /** The health_check tool is registered on the constructed Agent. */
  healthCheckRegistered: boolean;
  /** The verify_pdf_page_limit tool is registered on the constructed Agent. */
  verifyPdfPageLimitRegistered: boolean;
  /** The verify_local_repository tool is registered on the constructed Agent. */
  verifyLocalRepositoryRegistered: boolean;
}

/**
 * Registry/integration check (no model invocation): constructs the Proofline
 * agent and inspects its registered tools through the public Strands Agent
 * API (`agent.toolRegistry` / `ToolRegistry.get`).
 */
export function verifyProoflineToolRegistry(): ProoflineToolRegistryCheck {
  const agent = createProoflineAgent();
  const registry = agent.toolRegistry;
  return {
    healthCheckRegistered: registry.get('health_check') !== undefined,
    verifyPdfPageLimitRegistered: registry.get('verify_pdf_page_limit') !== undefined,
    verifyLocalRepositoryRegistered: registry.get('verify_local_repository') !== undefined,
  };
}

/**
 * Runs the Proofline agent locally with the mock model and returns a
 * deterministic proof payload. Performs no external network or model
 * provider call.
 */
export async function runProoflineAgent(): Promise<ProoflineAgentRunResult> {
  const agent = createProoflineAgent();

  const agentResult = await agent.invoke('Run the Proofline health check.');

  const toolResultBlock = agent.messages
    .flatMap((message) => message.content)
    .find((block): block is ToolResultBlock => block.type === 'toolResultBlock');

  return {
    constructed: true,
    toolExecuted: toolResultBlock?.status === 'success',
    stopReason: agentResult.stopReason,
    text: agentResult.toString(),
    toolResult: extractToolResultValue(toolResultBlock),
    agentResult,
  };
}

/** Result of the unified local agent integration check. */
export interface ProoflineToolIntegrationCheckResult {
  /** createProoflineAgent() constructed the Agent successfully. */
  constructed: boolean;
  /** The health_check tool is registered on the constructed Agent. */
  healthCheckRegistered: boolean;
  /** The verify_pdf_page_limit tool is registered on the constructed Agent. */
  verifyPdfPageLimitRegistered: boolean;
  /** The verify_local_repository tool is registered on the constructed Agent. */
  verifyLocalRepositoryRegistered: boolean;
  /** The existing health_check mock invocation executed successfully and reached endTurn. */
  healthCheckInvocationSucceeded: boolean;
  /** Final stop reason of the health_check invocation (expected 'endTurn'). */
  stopReason: string;
  /** No network or model provider was contacted (deterministic mock model only). */
  offline: boolean;
}

/**
 * Unified agent integration check: constructs the agent, verifies all three tools
 * are registered through the public Agent toolRegistry API, and re-runs the existing
 * health_check mock path. It performs NO PDF or repository filesystem setup — those
 * tools were already runtime-tested independently. Uses only ProoflineMockModel, so no
 * network or real model provider is contacted.
 */
export async function runProoflineToolIntegrationCheck(): Promise<ProoflineToolIntegrationCheckResult> {
  let registryResult: ProoflineToolRegistryCheck;
  try {
    registryResult = verifyProoflineToolRegistry();
  } catch {
    return {
      constructed: false,
      healthCheckRegistered: false,
      verifyPdfPageLimitRegistered: false,
      verifyLocalRepositoryRegistered: false,
      healthCheckInvocationSucceeded: false,
      stopReason: '',
      offline: true,
    };
  }

  let runResult: ProoflineAgentRunResult;
  try {
    runResult = await runProoflineAgent();
  } catch {
    return {
      constructed: true,
      ...registryResult,
      healthCheckInvocationSucceeded: false,
      stopReason: '',
      offline: true,
    };
  }

  return {
    constructed: true,
    ...registryResult,
    healthCheckInvocationSucceeded: runResult.toolExecuted && runResult.stopReason === 'endTurn',
    stopReason: runResult.stopReason,
    offline: true,
  };
}

function extractToolResultValue(block: ToolResultBlock | undefined): JSONValue | null {
  for (const content of block?.content ?? []) {
    if (content.type === 'jsonBlock') return content.json;
    if (content.type === 'textBlock') return content.text;
  }
  return null;
}
