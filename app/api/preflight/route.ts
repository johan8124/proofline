/**
 * Proofline preflight API boundary — server-side only.
 *
 * POST /api/preflight (multipart/form-data)
 *   file: File (required manuscript PDF upload)
 *   repositoryDirectory?: string (optional local filesystem directory path)
 *   repositoryUrl?: string (optional repository URL; public GitHub repos are
 *                          fetched to a temp directory and verified)
 * → { readiness, findings, evidenceLedger, pdfVerified, repositoryVerified,
 *     agentText, agentStopReason }
 *
 * Deterministic verification runs FIRST via the existing runPreflight()
 * orchestrator (lib/preflight/run-preflight.ts). Only the resulting
 * deterministic facts are then passed to the Strands explanation agent —
 * the PDF bytes are never sent to Groq. Agent failure never changes the
 * deterministic result: the deterministic payload is still returned with a
 * failure-safe agent message.
 */

import { NextResponse } from 'next/server';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  PreflightInputError,
  runPreflight,
} from '../../../lib/preflight/run-preflight';
import {
  preflightFactsFromResult,
  runProoflineAgentWithFacts,
  runRequestScopedPreflightAgent,
} from '../../../lib/agent/proofline-real-agent';
import {
  fetchPublicGitHubRepository,
  isPublicGitHubRepoUrl,
} from '../../../lib/repository/fetch-github-repository';

/** This route must always run in the Node.js runtime where fs/os exist. */
export const runtime = 'nodejs';

/** First 5 bytes every valid PDF must start with: "%PDF-". */
const PDF_MAGIC = '%PDF-';

function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

function optionalTextField(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Returns a public-safe source reference for the API response.
 * Server-local temporary manuscript paths are replaced with the safe
 * placeholder "manuscript.pdf". All other source references (repository
 * URLs, etc.) are returned unchanged.
 */
function publicSourceRef(sourceRef: string, tempManuscriptPath: string | null): string {
  return tempManuscriptPath !== null && sourceRef === tempManuscriptPath
    ? 'manuscript.pdf'
    : sourceRef;
}

/**
 * Replaces a server-local repository directory path inside a free-form text
 * field (finding reason or evidence details) with a neutral placeholder.
 * Only the exact directory path is replaced; repository URLs and all other
 * text are preserved unchanged.
 */
function publicTextField(text: string, repositoryDirectory: string | undefined): string {
  if (repositoryDirectory === undefined) {
    return text;
  }
  return text.split(repositoryDirectory).join('[local repository]');
}

export async function POST(request: Request) {
  // Point pdfjs at its real worker file via an absolute file URL. Next's
  // bundler rewrites the library's default relative "./pdf.worker.mjs" into a
  // chunk path that does not exist; the absolute URL keeps the deterministic
  // fake-worker (main-thread) setup working under both dev and build.
  if (typeof GlobalWorkerOptions.workerSrc !== 'string' || !GlobalWorkerOptions.workerSrc.startsWith('file:')) {
    try {
      const workerUrl = new URL(
        'pdf.worker.mjs',
        pathToFileURL(join(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/')),
      );
      GlobalWorkerOptions.workerSrc = workerUrl.href;
    } catch {
      // Fall through: pdf inspection reports a typed failure, never a 500 here.
    }
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return badRequest('Request body must be multipart FormData.');
  }

  const fileValue = formData.get('file');
  if (fileValue === null || typeof fileValue !== 'object' || typeof (fileValue as File).arrayBuffer !== 'function') {
    return badRequest('Field "file" is required and must be a PDF upload.');
  }
  const file = fileValue as File;

  if (typeof file.size !== 'number' || file.size === 0) {
    return badRequest('Field "file" must be a non-empty PDF upload.');
  }

  // Do not trust the filename alone: require PDF content via magic bytes.
  // MIME/extension are checked as secondary signals; content is decisive.
  const mimeType = typeof file.type === 'string' ? file.type : '';
  if (mimeType !== '' && mimeType !== 'application/pdf') {
    return badRequest('Field "file" must be a PDF (application/pdf).');
  }
  const fileName = typeof file.name === 'string' ? file.name : '';
  if (fileName !== '' && !fileName.toLowerCase().endsWith('.pdf')) {
    return badRequest('Field "file" must be a PDF (.pdf).');
  }

  let pdfBytes: Buffer;
  try {
    pdfBytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return badRequest('Field "file" could not be read as a PDF upload.');
  }
  if (pdfBytes.length < PDF_MAGIC.length || pdfBytes.toString('ascii', 0, PDF_MAGIC.length) !== PDF_MAGIC) {
    return badRequest('Field "file" must be a valid PDF (missing %PDF- header).');
  }

  let repositoryDirectory = optionalTextField(formData.get('repositoryDirectory'));
  const repositoryUrl = optionalTextField(formData.get('repositoryUrl'));

  if (repositoryDirectory !== undefined && repositoryUrl === undefined) {
    return badRequest(
      'Fields "repositoryDirectory" and "repositoryUrl" must be supplied together.',
    );
  }

  // Public GitHub URL without a local directory: fetch to a temp directory.
  let tempRepoDir: string | null = null;
  if (repositoryDirectory === undefined && repositoryUrl !== undefined) {
    if (!isPublicGitHubRepoUrl(repositoryUrl)) {
      return badRequest(
        'Field "repositoryUrl" must be a public GitHub repository URL (https://github.com/owner/repo).',
      );
    }
    try {
      tempRepoDir = await fetchPublicGitHubRepository(repositoryUrl);
      repositoryDirectory = tempRepoDir;
    } catch (error) {
      // Safe error message; never leak stack traces or server paths.
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to fetch the public GitHub repository.';
      return badRequest(message);
    }
  }

  let tempDir: string | null = null;
  let tempPdfPath: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'proofline-'));
    tempPdfPath = join(tempDir, 'manuscript.pdf');
    await writeFile(tempPdfPath, pdfBytes);

    // 1. Request-scoped Strands agent invokes safe verification tools and reasons from observations
    let orchestrationText: string | null = null;
    let orchestrationStopReason: string | null = null;
    let agentUnavailable = false;

    try {
      const orchestrationResult = await runRequestScopedPreflightAgent({
        pdfFilePath: tempPdfPath,
        repositoryDirectory,
        repositoryUrl,
      });
      orchestrationText = orchestrationResult.text;
      orchestrationStopReason = orchestrationResult.stopReason;
    } catch {
      agentUnavailable = true;
    }

    // 2. Authoritative deterministic preflight runs unconditionally with the exact same inputs
    const result = await runPreflight({
      pdfFilePath: tempPdfPath,
      ...(repositoryDirectory !== undefined && repositoryUrl !== undefined
        ? { repositoryDirectory, repositoryUrl }
        : {}),
    });

    // Distinguish how the repository was verified: "github" when the user
    // supplied only a public GitHub URL that was fetched to a temp directory,
    // "local" when the user supplied their own local directory, "none" otherwise.
    const repositorySource: 'github' | 'local' | 'none' =
      tempRepoDir !== null
        ? 'github'
        : repositoryDirectory !== undefined
          ? 'local'
          : 'none';

    // 3. Explanation step: synthesize tool observations + authoritative deterministic result
    let agentText: string;
    let agentStopReason: string;

    if (agentUnavailable) {
      agentText =
        'The deterministic verification completed, but the explanation ' +
        'assistant is temporarily unavailable. The readiness, findings, and ' +
        'evidence above are authoritative.';
      agentStopReason = 'agent_unavailable';
    } else {
      try {
        const facts = preflightFactsFromResult(result, repositorySource);
        if (orchestrationText !== null) {
          facts.agentInspectionObservation = orchestrationText;
        }
        const explanationResult = await runProoflineAgentWithFacts(facts);
        agentText = explanationResult.text;
        agentStopReason = explanationResult.stopReason;
      } catch {
        // If explanation step fails, format orchestration observations with required sections
        agentText =
          orchestrationText !== null && orchestrationText.trim().length > 0
            ? orchestrationText
            : 'The deterministic verification completed, but the explanation ' +
              'assistant is temporarily unavailable. The readiness, findings, and ' +
              'evidence above are authoritative.';
        agentStopReason = orchestrationStopReason ?? 'agent_unavailable';
      }
    }

    // Build a public-safe response copy: the internal deterministic result is
    // never mutated. Manuscript sourceRef values pointing at server-local
    // temporary paths are replaced with the safe placeholder "manuscript.pdf".
    // Repository directory paths inside finding.reason and evidence.details
    // are replaced with "[local repository]". Repository URLs and all other
    // verification facts are preserved unchanged.
    const publicFindings = result.readiness.findings.map((finding) => ({
      ...finding,
      sourceRef: publicSourceRef(finding.sourceRef, tempPdfPath),
      reason: publicTextField(finding.reason, repositoryDirectory),
    }));
    const publicEvidenceEntries = result.evidenceLedger.entries.map((entry) => ({
      ...entry,
      sourceRef: publicSourceRef(entry.sourceRef, tempPdfPath),
      details: entry.details !== undefined
        ? publicTextField(entry.details, repositoryDirectory)
        : undefined,
    }));

    return NextResponse.json(
      {
        readiness: {
          ...result.readiness,
          findings: publicFindings,
          evidenceLedger: { entries: publicEvidenceEntries },
        },
        findings: publicFindings,
        evidenceLedger: { entries: publicEvidenceEntries },
        pdfVerified: result.pdfVerified,
        repositoryVerified: result.repositoryVerified,
        repositorySource,
        agentText,
        agentStopReason,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof PreflightInputError) {
      return badRequest('Invalid preflight input.');
    }
    // Concise server error; never leak stack traces, env vars, or filesystem internals.
    return NextResponse.json(
      { error: 'Preflight request failed on the server.' },
      { status: 500 },
    );
  } finally {
    if (tempPdfPath !== null) {
      try {
        await rm(tempPdfPath, { force: true });
      } catch {
        // Ignore cleanup failures; the response status is already decided.
      }
    }
    if (tempDir !== null) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures; the response status is already decided.
      }
    }
    // Clean up the GitHub extraction temp directory (the extracted repo root
    // is inside a proofline-repo-* temp dir; remove the parent to delete all).
    if (tempRepoDir !== null) {
      try {
        const repoParentDir = dirname(tempRepoDir);
        await rm(repoParentDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures; the response status is already decided.
      }
    }
  }
}
