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
  const { readiness, findings, evidenceLedger, pdfVerified, repositoryVerified, repositorySource } =
    body;
  if (!isRecord(readiness) || typeof readiness.status !== 'string') return null;
  if (
    readiness.status !== 'ready' &&
    readiness.status !== 'blocked' &&
    readiness.status !== 'human_review'
  ) {
    return null;
  }
  if (!Array.isArray(findings) || !isRecord(evidenceLedger)) return null;
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
  for (const item of findings) {
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
    parsedEntries.push({ evidenceId, ruleId, sourceType, value, status, timestamp });
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

/** Renders one agent section body as readable plain paragraphs. */
function AgentSectionBody({ body }: { body: string }) {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length === 0) {
    return null;
  }
  return (
    <div className="mt-1 grid gap-2">
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="whitespace-pre-wrap text-sm leading-6 text-zinc-700 dark:text-zinc-300">
          {paragraph}
        </p>
      ))}
    </div>
  );
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

  const entryCount = result === null ? 0 : result.entries.length;

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

        {/* 5. Verification results */}
        <section className="mt-12">
          <h2 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Verification results
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {loading
              ? 'Verification in progress…'
              : result !== null
                ? `Preflight completed — ${readinessLabel(result.status)}`
                : error !== null
                  ? 'Preflight failed'
                  : 'Waiting for a submission'}
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">PDF</h3>
                <StatusBadge
                  label={
                    loading
                      ? 'Running'
                      : result !== null
                        ? result.pdfVerified
                          ? 'Verified'
                          : 'Not verified'
                        : 'Pending'
                  }
                  tone={result !== null && result.pdfVerified ? 'pass' : 'pending'}
                />
              </div>
              <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
                {loading
                  ? 'Uploading and verifying the manuscript…'
                  : result !== null
                    ? result.pdfVerified
                      ? 'Manuscript PDF verified.'
                      : 'Manuscript PDF not verified.'
                    : 'Waiting for a submission'}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Repository</h3>
                <StatusBadge
                  label={
                    loading
                      ? 'Running'
                      : result !== null
                        ? result.repositoryVerified
                          ? 'Verified'
                          : 'Not checked'
                        : 'Pending'
                  }
                  tone={result !== null && result.repositoryVerified ? 'pass' : 'pending'}
                />
              </div>
              <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
                {loading
                  ? 'Checking the repository…'
                  : result !== null
                    ? result.repositoryVerified
                      ? result.repositorySource === 'github'
                        ? 'Public GitHub repository fetched and verified.'
                        : 'Local repository directory verified.'
                      : 'No repository supplied.'
                    : 'Waiting for a submission'}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Evidence</h3>
                <StatusBadge
                  label={loading ? 'Running' : result !== null ? `${entryCount}` : 'Pending'}
                  tone={result !== null ? 'pass' : 'pending'}
                />
              </div>
              <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
                {loading
                  ? 'Recording evidence…'
                  : result !== null
                    ? `${entryCount} evidence ${entryCount === 1 ? 'entry' : 'entries'} recorded.`
                    : 'Waiting for a submission'}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Readiness</h3>
                <StatusBadge
                  label={loading ? 'Running' : result !== null ? readinessLabel(result.status) : 'Pending'}
                  tone={result !== null ? result.status : 'pending'}
                />
              </div>
              <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
                {loading
                  ? 'Determining readiness…'
                  : result !== null
                    ? `${result.passedCount} passed · ${result.blockingCount} blocking · ${result.humanReviewCount} for review.`
                    : 'Waiting for a submission'}
              </p>
            </div>
          </div>

          {error !== null && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
            >
              {error}
            </div>
          )}

          {result !== null && (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                  Readiness: {readinessLabel(result.status)}
                </h3>
                <StatusBadge label={readinessLabel(result.status)} tone={result.status} />
              </div>
              <div className="mt-4 grid gap-3">
                {result.findings.length === 0 ? (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    No findings returned by the API.
                  </p>
                ) : (
                  result.findings.map((finding) => (
                    <article
                      key={finding.findingId}
                      className="rounded-md border border-zinc-200 px-4 py-3 dark:border-zinc-800"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {finding.ruleId}
                        </p>
                        <StatusBadge label={finding.status.toUpperCase()} tone={finding.status} />
                      </div>
                      <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{finding.title}</p>
                      <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                        {finding.reason}
                      </p>
                      <p className="mt-2 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                        Evidence: {finding.evidenceId}
                      </p>
                    </article>
                  ))
                )}
              </div>
            </div>
          )}

          {result !== null && result.agentText !== null && (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
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
                      <AgentSectionBody body={section.body} />
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

        {/* 6 & 7. Evidence ledger + Readiness */}
        <section className="mt-12 grid gap-6 lg:grid-cols-2">
          <Card title="Evidence ledger">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Every finding links the requirement to the evidence that supports it.
            </p>
            {result === null || result.entries.length === 0 ? (
              <div className="mt-4 rounded-md border border-dashed border-zinc-300 px-4 py-8 text-center dark:border-zinc-700">
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {loading ? 'Recording evidence…' : 'No evidence recorded yet.'}
                </p>
              </div>
            ) : (
              <ul className="mt-4 grid gap-2">
                {result.entries.map((entry) => (
                  <li
                    key={entry.evidenceId}
                    className="rounded-md border border-zinc-200 px-3 py-2.5 dark:border-zinc-800"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                        {entry.evidenceId}
                      </span>
                      <StatusBadge label={entry.status.toUpperCase()} tone={entry.status} />
                    </div>
                    <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                      Rule {entry.ruleId} · value {entry.value} · {entry.sourceType}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                      {entry.timestamp}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Readiness">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {result === null
                ? 'Run a preflight to determine the current state.'
                : `Current state: ${readinessLabel(result.status)} — from the latest API response.`}
            </p>
            <div className="mt-4 grid gap-2">
              {(['ready', 'blocked', 'human_review'] as const).map((state) => {
                const label = readinessLabel(state);
                const active = result !== null && result.status === state;
                return (
                  <div
                    key={state}
                    className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2.5 dark:border-zinc-800"
                  >
                    <span className="text-xs font-semibold tracking-wide text-zinc-500 dark:text-zinc-400">
                      {label}
                    </span>
                    <span
                      className={`h-2 w-2 rounded-full ${
                        active
                          ? state === 'ready'
                            ? 'bg-emerald-500'
                            : state === 'blocked'
                              ? 'bg-red-500'
                              : 'bg-amber-500'
                          : 'bg-zinc-200 dark:bg-zinc-700'
                      }`}
                    />
                  </div>
                );
              })}
            </div>
          </Card>
        </section>
      </main>

      <footer className="border-t border-zinc-200 py-6 text-center text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
        Proofline · Submission preflight · Deterministic verification
      </footer>
    </div>
  );
}
