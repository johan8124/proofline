/**
 * DEVELOPMENT / TEST ONLY — deterministic mock Strands Model.
 *
 * ProoflineMockModel implements the Strands `Model` abstraction without ever
 * contacting an external LLM provider. It deterministically plays a fixed
 * two-turn script selected by an explicit constructor scenario:
 *
 *   'health_check' (default)   1. First model call   → emits a `health_check`
 *                              tool-use stream
 *                              2. Second model call  → emits a final
 *                              deterministic text turn
 *
 *   'verify_pdf_page_limit'    1. First model call   → emits a
 *                              `verify_pdf_page_limit` tool-use stream with a
 *                              configured runtime PDF path
 *                              2. Second model call  → emits a final
 *                              deterministic text turn containing the tool
 *                              result JSON
 *
 * How the script phase is chosen: after the agent executes a tool it appends
 * a user message containing a `toolResultBlock`. If the last message in the
 * conversation carries one, the tool has already run, so this call returns
 * the final text; otherwise it requests the tool.
 *
 * Scenario selection NEVER comes from user text — only from the explicit
 * constructor configuration. No network, no API calls, no external providers.
 */

import {
  Model,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';

const HEALTH_CHECK_TOOL_NAME = 'health_check';
const HEALTH_CHECK_TOOL_USE_ID = 'proofline-mock-tool-use-1';
const HEALTH_CHECK_FINAL_TEXT_PREFIX =
  'Proofline local invocation complete. health_check executed successfully. Tool result: ';

const PDF_PAGE_LIMIT_TOOL_NAME = 'verify_pdf_page_limit';
const PDF_PAGE_LIMIT_TOOL_USE_ID = 'proofline-mock-pdf-tool-use-1';
const PDF_PAGE_LIMIT_FINAL_TEXT_PREFIX =
  'Proofline local invocation complete. verify_pdf_page_limit executed successfully. Tool result: ';
const PDF_PAGE_LIMIT_MAX_PAGES = 8;
const PDF_PAGE_LIMIT_EVIDENCE_ID = 'ev-mock-pdf-page-limit';
const PDF_PAGE_LIMIT_TIMESTAMP = '2026-09-13T00:00:00.000Z';

/** Explicit scenario configurations accepted by the mock model constructor. */
export type ProoflineMockModelOptions =
  | { scenario: 'health_check' }
  | { scenario: 'verify_pdf_page_limit'; filePath: string };

/** Explicit scenario union supported by the mock model. */
export type ProoflineMockScenario = ProoflineMockModelOptions['scenario'];

interface ProoflineMockModelConfig {
  modelId: string;
  scenario: ProoflineMockScenario;
  /** Runtime PDF path; only set for the 'verify_pdf_page_limit' scenario. */
  filePath?: string;
}

export class ProoflineMockModel extends Model<ProoflineMockModelConfig> {
  private readonly _config: ProoflineMockModelConfig;

  constructor(options?: ProoflineMockModelOptions) {
    super();
    const scenario = options?.scenario ?? 'health_check';
    if (scenario === 'verify_pdf_page_limit') {
      const filePath = (options as { filePath?: string }).filePath;
      if (typeof filePath !== 'string' || filePath.length === 0) {
        throw new Error(
          "ProoflineMockModel scenario 'verify_pdf_page_limit' requires a string filePath.",
        );
      }
      this._config = {
        modelId: 'proofline-mock-model',
        scenario,
        filePath,
      };
    } else {
      this._config = {
        modelId: 'proofline-mock-model',
        scenario: 'health_check',
      };
    }
  }

  updateConfig(modelConfig: Partial<ProoflineMockModelConfig>): void {
    Object.assign(this._config, modelConfig);
  }

  getConfig(): ProoflineMockModelConfig {
    return { ...this._config };
  }

  async *stream(
    messages: Message[],
    _options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    void _options; // Deterministic mock: provider stream options are intentionally ignored.
    yield { type: 'modelMessageStartEvent', role: 'assistant' };

    if (this._toolHasRun(messages)) {
      const prefix =
        this._config.scenario === 'verify_pdf_page_limit'
          ? PDF_PAGE_LIMIT_FINAL_TEXT_PREFIX
          : HEALTH_CHECK_FINAL_TEXT_PREFIX;
      const text = prefix + JSON.stringify(this._extractToolResult(messages));
      for (const chunk of chunkText(text)) {
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: chunk },
        };
      }
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    } else {
      const toolUse = this._toolUseRequest();
      yield {
        type: 'modelContentBlockStartEvent',
        start: {
          type: 'toolUseStart',
          name: toolUse.name,
          toolUseId: toolUse.toolUseId,
        },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: toolUse.input },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    }

    yield {
      type: 'modelMetadataEvent',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      metrics: { latencyMs: 0 },
    };
  }

  private _toolHasRun(messages: Message[]): boolean {
    const last = messages[messages.length - 1];
    return last?.content.some((block) => block.type === 'toolResultBlock') ?? false;
  }

  /**
   * The deterministic tool-use request for the first model call, chosen
   * strictly from the explicit constructor scenario (never from user text).
   */
  private _toolUseRequest(): { name: string; toolUseId: string; input: string } {
    if (this._config.scenario === 'verify_pdf_page_limit') {
      return {
        name: PDF_PAGE_LIMIT_TOOL_NAME,
        toolUseId: PDF_PAGE_LIMIT_TOOL_USE_ID,
        input: JSON.stringify({
          filePath: this._config.filePath,
          maxPages: PDF_PAGE_LIMIT_MAX_PAGES,
          evidenceId: PDF_PAGE_LIMIT_EVIDENCE_ID,
          timestamp: PDF_PAGE_LIMIT_TIMESTAMP,
        }),
      };
    }
    return {
      name: HEALTH_CHECK_TOOL_NAME,
      toolUseId: HEALTH_CHECK_TOOL_USE_ID,
      input: '{}',
    };
  }

  private _extractToolResult(messages: Message[]): unknown {
    const last = messages[messages.length - 1];
    const toolResultBlock = last?.content.find((block) => block.type === 'toolResultBlock');
    for (const content of toolResultBlock?.content ?? []) {
      if (content.type === 'jsonBlock') return content.json;
      if (content.type === 'textBlock') return content.text;
    }
    return null;
  }
}

/** Splits text into tiny deterministic deltas to exercise the streaming path. */
function* chunkText(text: string): Generator<string> {
  for (let i = 0; i < text.length; i += 16) {
    yield text.slice(i, i + 16);
  }
}
