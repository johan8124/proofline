# Proofline

Proofline is an agentic submission preflight system that verifies whether a research submission package is actually ready. It performs deterministic checks on the manuscript and repository, records the results as evidence, derives a readiness state, and uses two Strands agent stages: a request-scoped orchestration agent that calls verification tools and reasons from observations, followed by a facts-only explanation agent that summarizes the authoritative result.

## Problem

Before submitting a paper to a conference or workshop, a researcher has to manually reconcile facts that live in several different places: page limits and formatting rules from the venue, the actual manuscript PDF, the contents of the code/data repository, required supplementary artifacts, and the submission portal's checklist. Each check is easy to get wrong, the evidence for each answer is scattered, and a single missed requirement — a page over the limit, a missing LICENSE file, an absent supplementary figure — can block or invalidate a submission. There is usually no single, trustworthy place that says: *this package is ready, and here is the evidence for every claim.*

## Solution

Proofline combines five layers with strictly separated responsibilities:

1. **Request-scoped orchestration agent** — a Strands agent calls `inspect_manuscript` and (when a repository is supplied) `inspect_repository`, then reasons from the actual tool observations. Server-local PDF and repository paths are closed over by the tools and are never exposed as free-form model parameters.
2. **Deterministic verification** — `runPreflight()` inspects the uploaded PDF and the local repository directory against a rule pack. No AI is involved in these checks; this step is authoritative for readiness, findings, and the Evidence Ledger.
3. **Evidence Ledger** — every deterministic check produces an immutable evidence entry recording what was checked, what was observed, and whether it passed, failed, or could not be verified.
4. **ReadinessResult** — the findings are deterministically aggregated into one of three states: `READY`, `BLOCKED`, or `HUMAN REVIEW`.
5. **Facts-only explanation agent** — a second Strands agent with **no verification tools registered** receives the authoritative deterministic facts plus the sanitized orchestration observations and writes a human-readable explanation. It explains the results; it never decides them.

## Core workflow

```
User
→ PDF upload
→ POST /api/preflight
→ request-scoped Strands agent
   → inspect_manuscript
   → inspect_repository when applicable
   → tool observations
→ deterministic runPreflight
→ Evidence Ledger + ReadinessResult
→ facts-only Strands explanation
→ UI/API response
```

Three invariants hold throughout:

- **`runPreflight()` is authoritative.** Page counts, file presence, rule outcomes, the Evidence Ledger, and the readiness state all come from deterministic code, never from a model.
- **The orchestration agent reasons from actual tool observations.** It calls `inspect_manuscript` and (when applicable) `inspect_repository`; it never invents verification facts.
- **AI output cannot change the deterministic result.** The explanation step receives authoritative facts plus sanitized orchestration observations. If either agent is unavailable, the deterministic payload is still returned, marked `agent_unavailable`.

## Current capabilities

What Proofline does today:

- **PDF upload** — the browser sends the manuscript as multipart form data to the API.
- **PDF page-count verification** — page count is inspected server-side with `pdfjs-dist` (content is validated by `%PDF-` magic bytes, not by filename).
- **8-page Example Conference page-limit rule** — `page_limit_max_8` from the example venue rule pack.
- **Local repository inspection** — a server-local directory is inspected to build a repository snapshot.
- **Repository file checks** — `repository_accessible`, `required_repository_file_readme` (`README.md`), `required_repository_file_license` (`LICENSE`), and `required_repository_file_supplementary` (`figures/results.pdf`).
- **Evidence Ledger** — one immutable ledger per preflight run, with one entry per check.
- **READY / BLOCKED / HUMAN REVIEW states** — derived deterministically from the findings.
- **Two-stage Strands Agents SDK architecture** — a request-scoped orchestration agent calls `inspect_manuscript` and (when applicable) `inspect_repository`, then a facts-only explanation agent with no verification tools generates the human-readable summary.
- **Groq OpenAI-compatible endpoint** — the Strands `OpenAIModel` points at `https://api.groq.com/openai/v1` (model `openai/gpt-oss-120b`); no separate Groq client is created.
- **API validation and temporary PDF cleanup** — malformed requests return structured 400 errors; the uploaded PDF is written to a temporary directory, verified, and deleted in a `finally` block.

What Proofline deliberately does **not** do today: GitHub API integration, Amazon Bedrock AgentCore, a database, authentication, background monitoring, automatic conference submission, or real multi-venue rule integrations.

## Readiness states

- **READY** — all applicable deterministic checks pass.
- **BLOCKED** — at least one deterministic finding fails.
- **HUMAN REVIEW** — no blocking failure exists, but one or more checks could not be verified and require human review. An `unsupported` verification is promoted to a `needs_review` finding so a submission is never silently marked ready when something could not actually be verified.

## Evidence Ledger

Each preflight run builds one immutable Evidence Ledger with one entry per check. An entry records the evidence ID, the rule ID, the source type (for example `pdf` or `repository`), the observed value, the status, and a timestamp. Findings are projections of these entries, and the readiness state is derived from the findings — so every rendered result traces back to a concrete evidence record.

Evidence IDs and timestamps are generated by the **application layer**, not by the LLM. The agent receives the finished ledger as input and cannot add, remove, or rewrite entries.

## Agent architecture

Proofline uses two distinct Strands agent stages, both backed by the `@strands-agents/sdk` with the `OpenAIModel` pointed at Groq's OpenAI-compatible endpoint (`openai/gpt-oss-120b`).

### Stage 1: Request-scoped orchestration agent

- Created per-request with tools that **close over server-local paths** — the model receives `inspect_manuscript` and (when a repository is supplied) `inspect_repository` as zero-argument tools. The PDF path and repository directory path are never exposed as free-form model parameters.
- The agent reasons from actual tool observations and cannot invent verification facts.
- Its output is a convenience observation trace; it has no authority over the readiness result.

### Stage 2: Facts-only explanation agent

- Constructed with **no verification tools registered** (`tools: []`), so it cannot re-verify anything or fabricate tool results.
- Receives the authoritative deterministic facts — readiness state, counts, findings, evidence ledger, `pdfVerified`/`repositoryVerified` flags — plus the sanitized orchestration observations, serialized as its prompt. Only these facts are sent; the manuscript PDF bytes are **not** sent to Groq.
- It **cannot change the deterministic result**: the API returns the deterministic payload regardless of agent output, and agent failure degrades to an explicit `agent_unavailable` message.

### Security behavior

- Manuscript `sourceRef` values pointing at the temporary server-side upload are returned publicly as `"manuscript.pdf"`. The internal deterministic result is not mutated; only a public-safe copy of the response is sanitized.
- No server filesystem paths or temporary directory prefixes are included in the facts sent to either agent.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the Mermaid architecture diagram and a walkthrough of the data flow from upload through deterministic verification, the Evidence Ledger, the ReadinessResult, and the agent explanation.

## Test scenarios

The following scenarios were verified against the running `POST /api/preflight` endpoint (not browser-level end-to-end testing):

1. **1-page valid PDF → READY** — the page-limit check passes.
2. **9-page valid PDF → BLOCKED** — `page_limit_max_8` fails.
3. **Header-valid but structurally invalid PDF → HUMAN REVIEW** — the page count cannot be determined, so `page_limit_max_8` becomes `needs_review` with `unsupported` evidence.
4. **Request-scoped Strands tool invocation** — `inspect_manuscript` is actually called by the orchestration agent.
5. **No server filesystem path in captured tool observations** — tool results never contain server-local paths.
6. **Public API `sourceRef`** — manuscript `sourceRef` uses `manuscript.pdf` instead of the temporary server path.
7. **Repository fixtures** — complete and incomplete repository fixtures exist and represent the documented repository checks.

Permanent fixtures in the repository:

- `test-fixtures/pdfs/corrupt.pdf` — a deliberately malformed PDF (header-valid but structurally invalid).
- `test-fixtures/repositories/complete-repository/` — contains `README.md`, `LICENSE`, and `figures/results.pdf`.
- `test-fixtures/repositories/incomplete-repository/` — contains `README.md` and `LICENSE` but no `figures/results.pdf`.

The 1-page and 9-page PDFs used in scenarios 1–2 were **generated for smoke testing** (minimal PDFs with a fixed number of pages) and are **not committed** to the repository.

## Local setup

Prerequisites:

- Node.js 20+ (the project uses Next.js 16 with the App Router)
- npm
- A Groq API key (see below)

Install dependencies (a `package-lock.json` is committed):

```bash
npm install
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | Yes (for the agent explanation) | Server-side API key for Groq. Read only in `lib/agent/proofline-real-agent.ts`; never exposed to the client or printed. |

Create a `.env.local` file in the repository root (it is git-ignored) and set the key:

```bash
GROQ_API_KEY=your-key-here
```

Without a valid key, deterministic verification still works: the API returns the full deterministic result with `agentStopReason: "agent_unavailable"` instead of a generated explanation.

## Running locally

Start the development server:

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

## API endpoint

`POST /api/preflight` — accepts `multipart/form-data`:

| Field | Required | Description |
| --- | --- | --- |
| `file` | Yes | The manuscript PDF. Validated by `%PDF-` magic bytes; a `.pdf` filename and non-empty body are also required. |
| `repositoryDirectory` | Optional | Server-local directory path of the repository to inspect. |
| `repositoryUrl` | Optional | Repository URL, recorded as metadata only. |

`repositoryDirectory` and `repositoryUrl` must be supplied together; a URL alone is rejected, because **repository verification currently requires a local directory** — the URL is never fetched.

On success the API returns HTTP 200 with JSON containing the `readiness` result, the `findings` array, the `evidenceLedger`, `pdfVerified`/`repositoryVerified` flags, and the `agentText`/`agentStopReason` explanation fields. Invalid input returns HTTP 400 with a concise `error` message; unexpected server failures return a generic HTTP 500 that never leaks stack traces, environment variables, or server filesystem paths. The temporary copy of the uploaded PDF is always deleted afterward.

## Repository fixtures

- **`test-fixtures/repositories/complete-repository/`** — satisfies every example repository rule: it is an inspectable local directory containing `README.md`, `LICENSE`, and `figures/results.pdf`, so all four checks (`repository_accessible`, `required_repository_file_readme`, `required_repository_file_license`, `required_repository_file_supplementary`) pass.
- **`test-fixtures/repositories/incomplete-repository/`** — contains `README.md` and `LICENSE` but is missing `figures/results.pdf`, so `required_repository_file_supplementary` fails and the preflight is BLOCKED.

Pass the fixture's absolute path as `repositoryDirectory` (together with a `repositoryUrl`) when running a preflight with a repository.

## Limitations

- **Repository verification is local-directory based.** Only directories on the server's filesystem can be verified; a repository URL is metadata and is never fetched.
- **Example Conference is an example rule pack.** The 8-page limit and the required-file rules are illustrative, not a real venue's official requirements.
- **No GitHub fetching.** There is no GitHub API integration of any kind.
- **No persistent database.** All results are returned per request; nothing is stored between runs.
- **No automatic submission.** Proofline does not submit anything to a venue on your behalf.
- The PDF is written to a temporary file on the server during verification, which ties the API to the Node.js runtime with filesystem access.

## Hackathon technologies

- **Next.js** (App Router, TypeScript) — UI and API route
- **TypeScript** — the entire codebase
- **Strands Agents SDK** (`@strands-agents/sdk`) — two-stage agent orchestration: request-scoped verification tool invocation and facts-only explanation
- **Groq** — OpenAI-compatible LLM endpoint (`openai/gpt-oss-120b`)
- **pdfjs-dist** — server-side PDF page-count inspection

No AWS services are currently used by the application.

## License

This project is licensed under the [MIT License](LICENSE).

