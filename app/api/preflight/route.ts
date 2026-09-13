/**
 * Proofline preflight API boundary — server-side only.
 *
 * POST /api/preflight (multipart/form-data)
 *   file: File (required manuscript PDF upload)
 *   repositoryDirectory?: string (optional local filesystem directory path)
 *   repositoryUrl?: string (optional repository URL metadata)
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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  PreflightInputError,
  runPreflight,
} from '../../../lib/preflight/run-preflight';
import {
  preflightFactsFromResult,
  runProoflineAgentWithFacts,
} from '../../../lib/agent/proofline-real-agent';

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

  const repositoryDirectory = optionalTextField(formData.get('repositoryDirectory'));
  const repositoryUrl = optionalTextField(formData.get('repositoryUrl'));
  if (repositoryDirectory !== undefined && repositoryUrl === undefined) {
    return badRequest(
      'Fields "repositoryDirectory" and "repositoryUrl" must be supplied together.',
    );
  }
  if (repositoryDirectory === undefined && repositoryUrl !== undefined) {
    return badRequest(
      'Field "repositoryUrl" alone cannot be verified; supply "repositoryDirectory" with it.',
    );
  }

  let tempDir: string | null = null;
  let tempPdfPath: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'proofline-'));
    tempPdfPath = join(tempDir, 'manuscript.pdf');
    await writeFile(tempPdfPath, pdfBytes);

    const result = await runPreflight({
      pdfFilePath: tempPdfPath,
      ...(repositoryDirectory !== undefined && repositoryUrl !== undefined
        ? { repositoryDirectory, repositoryUrl }
        : {}),
    });

    // Interpretation layer AFTER deterministic verification: only the
    // computed facts are sent to the model — never the PDF bytes.
    let agentText: string;
    let agentStopReason: string;
    try {
      const agentResult = await runProoflineAgentWithFacts(
        preflightFactsFromResult(result),
      );
      agentText = agentResult.text;
      agentStopReason = agentResult.stopReason;
    } catch {
      // Agent failure must not change the deterministic result.
      agentText =
        'The deterministic verification completed, but the explanation ' +
        'assistant is temporarily unavailable. The readiness, findings, and ' +
        'evidence above are authoritative.';
      agentStopReason = 'agent_unavailable';
    }

    return NextResponse.json(
      {
        readiness: result.readiness,
        findings: result.findings,
        evidenceLedger: result.evidenceLedger,
        pdfVerified: result.pdfVerified,
        repositoryVerified: result.repositoryVerified,
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
  }
}
