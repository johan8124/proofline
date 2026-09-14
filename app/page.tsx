/**
 * Proofline — functional preflight interface wired to POST /api/preflight.
 *
 * Client component: uploads the selected manuscript PDF as multipart FormData
 * to the deterministic preflight API and renders the structured result
 * (readiness, findings, evidence ledger) plus the explanatory agent text.
 * The deterministic readiness/findings/evidence are authoritative — the agent
 * text is explanatory only and never determines verification state.
 */

'use client';

import { useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { AgentMarkdown } from './components/agent-markdown';

/** Readiness status returned by POST /api/preflight. */
type ReadinessStatus = 'ready' | 'blocked' | 'human_review';

/** One finding projected from an evidence entry (API response shape). */
interface PreflightFinding {
  findingId: string;
  ruleId: string;
  title: string;
  status: string;
  reason: string;
  sourceType: string;
  sourceRef: string;
  evidenceId: string;
  recommendedAction: string;
}

/** One evidence ledger entry (API response shape). */
interface PreflightEvidenceEntry {
  evidenceId: string;
  ruleId: string;
  sourceType: string;
  value: string;
  status: string;
  timestamp: string;
  /** What was checked (e.g. 'page_count'). */
  checked: string;
  /** Reference to the concrete evidence source. */
  sourceRef: string;
  /** Longer detail text about the observation. */
  details: string;
  /** Recommended follow-up action code. */
  recommendedAction: string;
}

/** Structured preflight result stored in client state after a run. */
interface PreflightResult {
  status: ReadinessStatus;
  findings: PreflightFinding[];
  entries: PreflightEvidenceEntry[];
  passedCount: number;
  blockingCount: number;
  humanReviewCount: number;
  pdfVerified: boolean;
  /** Whether a repository (local directory or fetched public GitHub repo) was verified. */
  repositoryVerified: boolean;
  /** How the repository was verified: "github" for fetched public repos, "local" for user directories, "none" otherwise. */
  repositorySource: 'github' | 'local' | 'none';
  /** Explanatory agent text (never authoritative for verification state). */
  agentText: string | null;
  /** Why the agent turn stopped: "endTurn" | "agent_unavailable" | other. */
  agentStopReason: string | null;
}

/** One rendered agent-explanation section (known ## headings only). */
interface AgentSection {
  title: string;
  body: string;
}

/** Known agent markdown sections, in the order the agent is told to emit. */
const AGENT_SECTION_TITLES = [
  'Summary',
  'Verified state',
  'Issues',
  'Recommended actions',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parses the structured /api/preflight JSON into client state.
 * Returns null when the shape is unexpected — the UI never invents results.
 */
function parsePreflightResult(body: unknown): PreflightResult | null {
  if (!isRecord(body)) return null;
  const { readiness, evidenceLedger, pdfVerified, repositoryVerified, repositorySource } = body;
  if (!isRecord(readiness) || typeof readiness.status !== 'string') return null;
  if (
    readiness.status !== 'ready' &&
    readiness.status !== 'blocked' &&
    readiness.status !== 'human_review'
  ) {
    return null;
  }
  // Use the authoritative readiness.findings array directly. This ensures all
  // UI sections consume the same deduplicated findings that the result summary
  // and agent facts use.
  const readinessFindings = readiness.findings;
  if (!Array.isArray(readinessFindings) || !isRecord(evidenceLedger)) return null;
  if (!Array.isArray(evidenceLedger.entries)) return null;
  if (typeof pdfVerified !== 'boolean' || typeof repositoryVerified !== 'boolean') return null;
  if (
    repositorySource !== 'github' &&
    repositorySource !== 'local' &&
    repositorySource !== 'none'
  ) {
    return null;
  }

  const parsedFindings: PreflightFinding[] = [];
  for (const item of readinessFindings) {
    if (!isRecord(item)) return null;
    const findingId = optionalString(item.findingId);
    const ruleId = optionalString(item.ruleId);
    const title = optionalString(item.title);
    const status = optionalString(item.status);
    const reason = optionalString(item.reason);
    const evidenceId = optionalString(item.evidenceId);
    if (
      findingId === undefined ||
      ruleId === undefined ||
      title === undefined ||
      status === undefined ||
      reason === undefined ||
      evidenceId === undefined
    ) {
      return null;
    }
    parsedFindings.push({
      findingId,
      ruleId,
      title,
      status,
      reason,
      sourceType: optionalString(item.sourceType) ?? '',
      sourceRef: optionalString(item.sourceRef) ?? '',
      evidenceId,
      recommendedAction: optionalString(item.recommendedAction) ?? '',
    });
  }

  const parsedEntries: PreflightEvidenceEntry[] = [];
  for (const item of evidenceLedger.entries) {
    if (!isRecord(item)) return null;
    const evidenceId = optionalString(item.evidenceId);
    const ruleId = optionalString(item.ruleId);
    const sourceType = optionalString(item.sourceType);
    const value = optionalString(item.value);
    const status = optionalString(item.status);
    const timestamp = optionalString(item.timestamp);
    if (
      evidenceId === undefined ||
      ruleId === undefined ||
      sourceType === undefined ||
      value === undefined ||
      status === undefined ||
      timestamp === undefined
    ) {
      return null;
    }
    parsedEntries.push({
      evidenceId,
      ruleId,
      sourceType,
      value,
      status,
      timestamp,
      checked: optionalString(item.checked) ?? '',
      sourceRef: optionalString(item.sourceRef) ?? '',
      details: optionalString(item.details) ?? '',
      recommendedAction: optionalString(item.recommendedAction) ?? '',
    });
  }

  const passedCount = typeof readiness.passedCount === 'number' ? readiness.passedCount : 0;
  const blockingCount = typeof readiness.blockingCount === 'number' ? readiness.blockingCount : 0;
  const humanReviewCount =
    typeof readiness.humanReviewCount === 'number' ? readiness.humanReviewCount : 0;

  // Agent explanation is explanatory only: accept it when present, ignore it
  // when absent, and never let it affect readiness/findings/evidence above.
  const agentText = optionalString(body.agentText) ?? null;
  const agentStopReason = optionalString(body.agentStopReason) ?? null;

  return {
    status: readiness.status,
    findings: parsedFindings,
    entries: parsedEntries,
    passedCount,
    blockingCount,
    humanReviewCount,
    pdfVerified,
    repositoryVerified,
    repositorySource,
    agentText,
    agentStopReason,
  };
}

/** Maps a readiness status to its prominent display label. */
function readinessLabel(status: ReadinessStatus): string {
  if (status === 'human_review') return 'HUMAN REVIEW';
  return status.toUpperCase();
}

/** Pill styling per readiness/finding status. */
function statusPillClass(status: string): string {
  if (status === 'ready' || status === 'pass') {
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
  }
  if (status === 'blocked' || status === 'fail') {
    return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
  }
  return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
}

/** Small status pill used by the results cards, findings, and ledger. */
function StatusBadge({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusPillClass(tone)}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/** Inert Proofline wordmark. */
function Wordmark() {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Proofline
      </span>
      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
        Submission preflight
      </span>
    </div>
  );
}

/** Splits agent markdown into the known ## sections (safe, no packages). */
function parseAgentSections(agentText: string): AgentSection[] {
  const lines = agentText.split('\n');
  const sections: AgentSection[] = [];
  let currentTitle: string | null = null;
  let currentBody: string[] = [];
  const flush = () => {
    if (currentTitle !== null) {
      sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
    }
    currentTitle = null;
    currentBody = [];
  };
  for (const line of lines) {
    const match = /^##\s+(.+)\s*$/.exec(line.trim());
    if (match !== null) {
      flush();
      currentTitle = match[1].trim();
    } else if (currentTitle !== null) {
      currentBody.push(line);
    }
  }
  flush();
  // Keep only the known sections, in the canonical order.
  const byTitle = new Map(sections.map((section) => [section.title, section.body]));
  const ordered: AgentSection[] = [];
  for (const title of AGENT_SECTION_TITLES) {
    const body = byTitle.get(title);
    if (body !== undefined && body.length > 0) {
      ordered.push({ title, body });
    }
  }
  return ordered;
}

/** Card shell with a bordered heading. */
function Card({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
        <h2 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {title}
        </h2>
      </div>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

/* --------------------------------------------------------------------------- */
/* Result experience — submission-preflight presentation                       */
/* --------------------------------------------------------------------------- */

/** Human label for a recommended-action code. */
function recommendedActionText(action: string): string {
  switch (action) {
    case 'fix':
      return 'Fix — resolve the issue before submitting.';
    case 'verify':
      return 'Verify — confirm the requirement manually, then re-run preflight.';
    case 'human_review':
      return 'Human review — a person must confirm before submission.';
    case 'none':
      return 'No action required.';
    default:
      return 'Review manually before submitting.';
  }
}

/** Short human label for an evidence source type. */
function sourceTypeLabel(sourceType: string): string {
  switch (sourceType) {
    case 'pdf':
      return 'Manuscript PDF';
    case 'repository':
      return 'Repository';
    case 'url':
      return 'URL';
    case 'file':
      return 'File';
    case 'manual':
      return 'Manual';
    default:
      return sourceType;
  }
}

/** Concise repository summary for the result summary strip. */
function repositorySourceText(result: PreflightResult): string {
  if (result.repositorySource === 'github') return 'GitHub';
  if (result.repositorySource === 'local') return 'Local';
  return 'None';
}

function repositorySourceSubline(result: PreflightResult): string {
  if (result.repositorySource === 'github') return 'public repo fetched & inspected';
  if (result.repositorySource === 'local') return 'directory inspected';
  return 'not supplied';
}

/** Compact deterministic timestamp for the ledger (e.g. 2026-09-13 00:00:01 UTC). */
function formatTimestamp(timestamp: string): string {
  const value = timestamp ?? '';
  const normalized = value.replace('T', ' ').replace(/Z$/i, ' UTC');
  return normalized.length > 0 ? normalized : value;
}

/** Observed availability, expressed for the cross-artifact chain. */
function availabilityLabel(value: string): string {
  switch (value) {
    case 'present':
      return 'Verified present';
    case 'missing':
    case 'not_listed':
      return 'Missing';
    case 'unknown':
      return 'Not determined';
    default:
      return value;
  }
}

/** Decision label derived from the entry status. */
function resultingDecisionText(status: string): string {
  if (status === 'pass') return 'Requirement satisfied';
  if (status === 'fail') return 'Submission blocked';
  return 'Needs human review';
}

/** Parsed cross-artifact relationship from one ledger entry. */
interface CrossArtifactRelation {
  isCrossArtifact: boolean;
  manuscriptRuleId: string;
  manuscriptRequirement: string;
  artifactPath: string;
  availability: string;
}

/**
 * Recognizes the supplementary-results cross-artifact entry and extracts the
 * relationship chain it records. Supports both ledger shapes: entries whose
 * details explicitly name the linked manuscript-side rule, and entries from
 * the live repository pipeline (details carry the required path and the
 * observed availability). The linked manuscript rule for
 * `supplementary_results_artifact_*` entries is defined by the example venue
 * rule set (`required_file_supplementary`) and is used here only as display
 * fallback metadata — it never influences verification state.
 */
function crossArtifactInfo(entry: PreflightEvidenceEntry): CrossArtifactRelation {
  const details = entry.details || '';
  const manuscriptRuleMatch =
    /satisfies manuscript-side venue rule '([^']+)' \(([^)]+)\)\./.exec(details);
  const artifactPathMatch =
    /Repository artifact '([^']+)'/.exec(details) ??
    /Required repository file path '([^']+)'/.exec(details);
  const availabilityMatch = /availability '([^']+)'/.exec(details);
  const isCrossArtifact =
    entry.ruleId.startsWith('supplementary_results_artifact') || manuscriptRuleMatch !== null;
  return {
    isCrossArtifact,
    manuscriptRuleId:
      manuscriptRuleMatch?.[1] ?? 'required_file_supplementary',
    manuscriptRequirement:
      manuscriptRuleMatch?.[2] ?? 'The submission must include supplementary.pdf.',
    artifactPath: artifactPathMatch?.[1] ?? entry.sourceRef ?? '',
    availability: availabilityMatch?.[1] ?? entry.value ?? '',
  };
}

/** Minimal status glyph for the readiness banner (inline SVG, no deps). */
function ReadinessGlyph({ status }: { status: ReadinessStatus }) {
  if (status === 'ready') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
        className="h-6 w-6"
      >
        <circle cx="12" cy="12" r="9" strokeOpacity={0.3} />
        <path d="M8.25 12.25l2.5 2.5 5-5.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === 'blocked') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
        className="h-6 w-6"
      >
        <circle cx="12" cy="12" r="9" strokeOpacity={0.3} />
        <path d="M9.25 9.25l5.5 5.5M14.75 9.25l-5.5 5.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
      className="h-6 w-6"
    >
      <path d="M12 5L20.5 19.5h-17L12 5z" strokeLinejoin="round" />
      <path d="M12 10.5v4" strokeLinecap="round" />
      <circle cx="12" cy="17.25" r="0.5" fill="currentColor" />
    </svg>
  );
}

/** Dominant readiness state banner — the strongest element of the result. */
function ReadinessBanner({ result }: { result: PreflightResult }) {
  const status = result.status;
  const copy =
    status === 'ready'
      ? `Proofline deterministically verified every check in this submission against explicit venue rules. ${result.passedCount} ${result.passedCount === 1 ? 'check' : 'checks'} proven by recorded evidence — no guesswork, no model judgment.`
      : status === 'blocked'
        ? `Proofline found this submission is not ready. ${result.blockingCount} blocking ${result.blockingCount === 1 ? 'issue' : 'issues'} must be resolved before submission — the most important one is listed first below.`
        : `Proofline could not safely establish whether this submission is ready. ${result.humanReviewCount} ${result.humanReviewCount === 1 ? 'item' : 'items'} could not be verified deterministically and need a person to review.`;

  return (
    <section className={`pl-banner pl-banner-${status}`} aria-live="polite">
      <div className="pl-banner-icon">
        <ReadinessGlyph status={status} />
      </div>
      <div className="pl-banner-content">
        <p className="pf-eyebrow">Submission readiness</p>
        <h3 className="pl-banner-title">{readinessLabel(status)}</h3>
        <p className="pl-banner-copy">{copy}</p>
      </div>
    </section>
  );
}

/** Four-figure summary of the completed run. */
function ResultSummary({ result }: { result: PreflightResult }) {
  const stats: Array<{
    label: string;
    value: string;
    sub: string;
    tone: 'neutral' | 'blocked' | 'review';
  }> = [
    {
      label: 'Checks proven',
      value: String(result.passedCount),
      sub: 'deterministic verification',
      tone: 'neutral',
    },
    {
      label: 'Blocking issues',
      value: String(result.blockingCount),
      sub: 'must be resolved',
      tone: result.blockingCount > 0 ? 'blocked' : 'neutral',
    },
    {
      label: 'Human review',
      value: String(result.humanReviewCount),
      sub: result.humanReviewCount === 1 ? 'needs a person' : 'need a person',
      tone: result.humanReviewCount > 0 ? 'review' : 'neutral',
    },
    {
      label: 'Repository',
      value: repositorySourceText(result),
      sub: repositorySourceSubline(result),
      tone: 'neutral',
    },
  ];

  const statToneClass = (tone: 'neutral' | 'blocked' | 'review'): string => {
    if (tone === 'blocked') return ' pl-stat--blocked';
    if (tone === 'review') return ' pl-stat--review';
    return '';
  };

  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className={`pl-stat${statToneClass(stat.tone)}`}>
          <dt className="pl-stat-label">{stat.label}</dt>
          <dd className="pl-stat-value">{stat.value}</dd>
          <dd className="pl-stat-sub">{stat.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One blocking / review finding with its remediation. */
function FindingItem({
  finding,
  index,
  tone,
}: {
  finding: PreflightFinding;
  index: number;
  tone: 'blocked' | 'review';
}) {
  return (
    <li className="pl-list-item">
      <div className="flex items-start gap-3">
        <span className="pl-index">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            {finding.title}
          </h4>
          <p className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            {finding.ruleId}
          </p>
        </div>
        <StatusBadge label={finding.status.toUpperCase()} tone={finding.status} />
      </div>
      <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{finding.reason}</p>
      <div className="pl-remediation mt-3" data-tone={tone}>
        <span className="pl-remediation-label">Recommended action</span>
        <span className="pl-remediation-text">{recommendedActionText(finding.recommendedAction)}</span>
      </div>
    </li>
  );
}

/** Blocking issues — immediately visible, first item is most important. */
function BlockingIssues({ result }: { result: PreflightResult }) {
  const blockers = result.findings.filter((finding) => finding.status === 'fail');
  if (blockers.length === 0) return null;
  return (
    <section className="pf-panel" aria-labelledby="blocking-heading">
      <div className="pf-panel-header">
        <div>
          <p className="pf-eyebrow">Must resolve before submission</p>
          <h3
            id="blocking-heading"
            className="mt-1 text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
          >
            Blocking issues
          </h3>
        </div>
        <span className="pl-count pl-count--blocked">
          {blockers.length} {blockers.length === 1 ? 'issue' : 'issues'}
        </span>
      </div>
      <ol className="pl-list">
        {blockers.map((finding, index) => (
          <FindingItem key={finding.findingId} finding={finding} index={index} tone="blocked" />
        ))}
      </ol>
    </section>
  );
}

/** Human-review items — visually distinct from blocking issues. */
function ReviewItems({ result }: { result: PreflightResult }) {
  const items = result.findings.filter(
    (finding) => finding.status === 'needs_review' || finding.status === 'unsupported',
  );
  if (items.length === 0) return null;
  return (
    <section className="pf-panel" aria-labelledby="review-heading">
      <div className="pf-panel-header">
        <div>
          <p className="pf-eyebrow">Proofline could not fully verify</p>
          <h3
            id="review-heading"
            className="mt-1 text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
          >
            Items requiring human review
          </h3>
        </div>
        <span className="pl-count pl-count--review">
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </span>
      </div>
      <ol className="pl-list">
        {items.map((finding, index) => (
          <FindingItem key={finding.findingId} finding={finding} index={index} tone="review" />
        ))}
      </ol>
    </section>
  );
}

/** Quiet summary of what Proofline inspected during this run. */
function Investigation({ result }: { result: PreflightResult }) {
  const ruleCount = new Set(result.findings.map((finding) => finding.ruleId)).size;
  const pdfEntry = result.entries.find((entry) => entry.sourceType === 'pdf');
  const repoEntry = result.entries.find((entry) => entry.sourceType === 'repository');
  const manuscriptRef = pdfEntry?.sourceRef || 'manuscript.pdf';
  const manuscriptNote = pdfEntry
    ? pdfEntry.value === 'unknown'
      ? 'page count could not be read'
      : `page count ${pdfEntry.value}`
    : '';

  const cells = [
    {
      label: 'Manuscript inspected',
      value: 'manuscript.pdf',
      sub: manuscriptRef !== 'manuscript.pdf' ? manuscriptRef : manuscriptNote,
    },
    {
      label: 'Repository inspected',
      value: repositorySourceText(result),
      sub:
        result.repositorySource === 'none'
          ? 'not supplied'
          : repoEntry?.sourceRef || 'inspected',
    },
    {
      label: 'Rules checked',
      value: String(ruleCount),
      sub: 'explicit venue + repository rules',
    },
    {
      label: 'Deterministic verification',
      value: 'Completed',
      sub: `${result.entries.length} evidence ${result.entries.length === 1 ? 'record' : 'records'}`,
    },
  ];

  return (
    <section className="pf-panel" aria-labelledby="investigation-heading">
      <div className="pf-panel-header">
        <div>
          <p className="pf-eyebrow">What Proofline inspected</p>
          <h3
            id="investigation-heading"
            className="mt-1 text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
          >
            Investigation
          </h3>
        </div>
      </div>
      <dl className="pl-investigation-grid">
        {cells.map((cell) => (
          <div key={cell.label} className="pl-investigation-cell">
            <dt className="pl-investigation-label">{cell.label}</dt>
            <dd className="pl-investigation-value">{cell.value}</dd>
            <dd className="pl-investigation-sub">{cell.sub}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** One evidence ledger row — claim, evidence, rule, and resulting status.
 *  Uses the deterministic helpers to render each claim as a trust surface
 *  record with an optional cross-artifact chain. */
function LedgerEntry({ entry }: { entry: PreflightEvidenceEntry }) {
  const crossInfo = crossArtifactInfo(entry);
  const decision = resultingDecisionText(entry.status);

  return (
    <li className="pl-ledger-record">
      <div className="pl-ledger-record-top">
        <span className="font-mono text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
          {entry.evidenceId}
        </span>
        <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
          {sourceTypeLabel(entry.sourceType)}
        </span>
        <StatusBadge label={entry.status.toUpperCase()} tone={entry.status} />
      </div>

      <dl className="pl-ledger-fields">
        <div className="pl-ledger-field">
          <dt>Rule</dt>
          <dd className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
            {entry.ruleId}
          </dd>
        </div>
        <div className="pl-ledger-field">
          <dt>Checked</dt>
          <dd>{entry.checked}</dd>
        </div>
        <div className="pl-ledger-field pl-ledger-field--span">
          <dt>Value</dt>
          <dd>{entry.value}</dd>
        </div>
        <div className="pl-ledger-field">
          <dt>Decision</dt>
          <dd>{decision}</dd>
        </div>
        <div className="pl-ledger-field">
          <dt>Recorded</dt>
          <dd>{formatTimestamp(entry.timestamp)}</dd>
        </div>
        <div className="pl-ledger-field">
          <dt>Reference</dt>
          <dd>{entry.sourceRef || '—'}</dd>
        </div>
      </dl>

      {entry.details && (
        <p className="mt-3 text-xs leading-5 text-zinc-600 dark:text-zinc-400">
          {entry.details}
        </p>
      )}

      {crossInfo.isCrossArtifact && (
        <div className={`mt-3 pl-chain pl-chain-${entry.status}`}>
          <span className="pl-chain-step">
            <span className="pl-chain-step-key">Manuscript rule</span>
            <span className="pl-chain-step-value">{crossInfo.manuscriptRuleId}</span>
            <span className="pl-chain-step-note">
              {crossInfo.manuscriptRequirement}
            </span>
          </span>
          <span className="pl-chain-arrow">→</span>
          <span className="pl-chain-step">
            <span className="pl-chain-step-key">Artifact path</span>
            <span className="pl-chain-step-value">{crossInfo.artifactPath}</span>
          </span>
          <span className="pl-chain-arrow">→</span>
          <span className="pl-chain-step">
            <span className="pl-chain-step-key">Availability</span>
            <span className="pl-chain-step-value">
              {availabilityLabel(crossInfo.availability)}
            </span>
          </span>
          <span className="pl-chain-arrow">→</span>
          <span className="pl-chain-step">
            <span className="pl-chain-step-key">Decision</span>
            <span className="pl-chain-step-value">{decision}</span>
          </span>
        </div>
      )}
    </li>
  );
}

/** Evidence Ledger — the central trust/verification surface. */
function EvidenceLedger({ result }: { result: PreflightResult }) {
  return (
    <section className="pf-panel" aria-labelledby="ledger-heading">
      <div className="pf-panel-header">
        <div>
          <p className="pf-eyebrow">Central verification surface</p>
          <h3
            id="ledger-heading"
            className="mt-1 text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
          >
            Evidence Ledger
          </h3>
          <p className="mt-1 max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            Every check records the claim, the evidence that supports it, the rule it satisfies,
            and the resulting status — the authoritative record of this run.
          </p>
        </div>
        <span className="pl-count">
          {result.entries.length} {result.entries.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>
      <ol className="pl-ledger-list">
        {result.entries.length === 0 ? (
          <li className="px-5 py-10 text-center">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No evidence was recorded for this run.
            </p>
          </li>
        ) : (
          result.entries.map((entry) => <LedgerEntry key={entry.evidenceId} entry={entry} />)
        )}
      </ol>
    </section>
  );
}

/* === pf-components-e === */

export default function Home() {
  const [selectedPdf, setSelectedPdf] = useState<File | null>(null);
  const [repositoryDirectory, setRepositoryDirectory] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handlePdfChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file !== null && !file.name.toLowerCase().endsWith('.pdf')) {
      setSelectedPdf(null);
      setResult(null);
      setError('Please choose a .pdf file.');
      return;
    }
    setSelectedPdf(file);
    setResult(null);
    if (error !== null) setError(null);
  }

  async function handleRunPreflight() {
    if (loading) return;
    if (selectedPdf === null) {
      setError('Please choose a manuscript PDF before running preflight.');
      return;
    }
    const directory = repositoryDirectory.trim();
    const url = repositoryUrl.trim();
    if (directory.length > 0 && url.length === 0) {
      setError(
        'A local repository directory requires a repository URL. Provide a URL, with or without a local directory.',
      );
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append('file', selectedPdf);
      if (directory.length > 0) {
        formData.append('repositoryDirectory', directory);
      }
      if (url.length > 0) {
        formData.append('repositoryUrl', url);
      }
      const response = await fetch('/api/preflight', {
        method: 'POST',
        body: formData,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          isRecord(body) && typeof body.error === 'string' && body.error.length > 0
            ? body.error
            : `Preflight request failed (HTTP ${response.status}).`;
        setError(message);
        return;
      }
      const parsed = parsePreflightResult(body);
      if (parsed === null) {
        setError('The preflight API returned an unexpected response.');
        return;
      }
      setResult(parsed);
    } catch {
      setError('Could not reach the preflight API. Is the server running?');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-full flex-1 flex-col bg-zinc-50 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      {/* 1. Header */}
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Wordmark />
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">
            <span>Manuscript</span>
            <span className="h-1 w-1 rounded-full bg-zinc-300 dark:bg-zinc-600" />
            <span>Repository</span>
            <span className="h-1 w-1 rounded-full bg-zinc-300 dark:bg-zinc-600" />
            <span>Evidence</span>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        {/* 2. Hero */}
        <section className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
            Proofline · Submission preflight
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl dark:text-zinc-50">
            Prove your submission is ready.
          </h1>
          <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
            Verify your paper, repository, and submission requirements with evidence,
            not guesswork. Proofline checks a submission package against explicit
            requirements and records every finding as evidence you can inspect.
          </p>
        </section>

        {/* 3. Submission setup */}
        <Card title="Submission setup">
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="lg:col-span-2">
              <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Manuscript PDF
              </h3>
              <div className="mt-2 rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 px-5 py-8 text-center dark:border-zinc-700 dark:bg-zinc-800/40">
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                  {selectedPdf === null ? 'Drop your manuscript PDF here' : selectedPdf.name}
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  PDF files only
                </p>
                <label
                  htmlFor="manuscript-pdf-input"
                  className="mt-4 inline-flex cursor-pointer items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:text-zinc-50"
                >
                  {selectedPdf === null ? 'Choose PDF' : 'Change PDF'}
                  <input
                    id="manuscript-pdf-input"
                    type="file"
                    accept=".pdf,application/pdf"
                    className="sr-only"
                    onChange={handlePdfChange}
                  />
                </label>
                <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">
                  {selectedPdf === null
                    ? 'No file selected yet.'
                    : 'Selected locally — will be uploaded when you run preflight.'}
                </p>
              </div>
            </div>

            <div>
              <label
                htmlFor="repository-url"
                className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
              >
                Repository URL
              </label>
              <input
                id="repository-url"
                type="text"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://github.com/you/your-repository"
                className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500"
              />
              <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                Public GitHub repositories can be fetched and verified automatically. A local directory is optional for local development/testing.
              </p>
            </div>

            <div>
              <label
                htmlFor="repository-directory"
                className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
              >
                Local repository directory
              </label>
              <input
                id="repository-directory"
                type="text"
                value={repositoryDirectory}
                onChange={(event) => setRepositoryDirectory(event.target.value)}
                placeholder="C:\Users\DELL\my-repository"
                className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500"
              />
              <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                Only a local directory can be verified. Optional — PDF-only preflight works without it.
              </p>
            </div>

            <div>
              <label
                htmlFor="venue"
                className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
              >
                Venue / rules
              </label>
              <select
                id="venue"
                defaultValue="example-conference"
                className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              >
                <option value="example-conference">Example Conference</option>
              </select>
              <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                8 page maximum · supplementary artifact · repository
              </p>
            </div>
          </div>

          {/* 4. Primary action */}
          <div className="mt-6 flex flex-col items-start gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-4 dark:border-zinc-800 dark:bg-zinc-800/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <button
              type="button"
              onClick={handleRunPreflight}
              disabled={loading}
              className="w-full cursor-pointer rounded-md bg-zinc-900 px-8 py-3 text-base font-semibold text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500 sm:w-auto"
            >
              {loading ? 'Running preflight…' : 'Run preflight'}
            </button>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {loading
                ? 'Verification in progress…'
                : 'Uploads the selected PDF to the deterministic preflight API.'}
            </p>
          </div>
        </Card>

        {/* 5. Result experience — deterministic readiness, findings, evidence */}
        <section className="mt-12 space-y-6">
          {error !== null && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
            >
              {error}
            </div>
          )}

          {result !== null && (
            <>
              <ReadinessBanner result={result} />
              <div className="mt-6">
                <ResultSummary result={result} />
              </div>
              <BlockingIssues result={result} />
              <ReviewItems result={result} />
              <Investigation result={result} />
              <EvidenceLedger result={result} />
            </>
          )}

          {result !== null && result.agentText !== null && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                  Explanation
                </h3>
                <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                  {result.agentStopReason === 'endTurn'
                    ? 'Explanation generated by Proofline agent'
                    : result.agentStopReason === 'agent_unavailable'
                      ? 'Agent unavailable — deterministic results below remain authoritative'
                      : 'Explanatory only — deterministic results remain authoritative'}
                </span>
              </div>
              {result.agentStopReason === 'agent_unavailable' ? (
                <p className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
                  Deterministic verification completed successfully and remains
                  authoritative. The explanation assistant is temporarily
                  unavailable.
                </p>
              ) : (
                <div className="mt-4 grid gap-4">
                  {parseAgentSections(result.agentText).map((section) => (
                    <div key={section.title}>
                      <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
                        {section.title}
                      </h4>
                      <AgentMarkdown text={section.body} />
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-4 text-[11px] text-zinc-400 dark:text-zinc-500">
                Explanatory only — readiness, findings, and evidence above are authoritative.
              </p>
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-zinc-200 py-6 text-center text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
        Proofline · Submission preflight · Deterministic verification
      </footer>
    </div>
  );
}
