/**
 * Proofline public GitHub repository fetcher — server-only.
 *
 * Fetches a PUBLIC GitHub repository by downloading its tarball and
 * extracting it into a temporary directory using only Node.js built-ins
 * (https + zlib + manual tar parsing). No external dependencies, no git
 * binary, no GitHub API token, no authentication.
 *
 * Supports PUBLIC repositories only. Validates the URL format before any
 * network call. Never follows arbitrary URLs.
 */

import { get } from 'node:https';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';

const MAX_TAR_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_FILES = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const TAR_BLOCK_SIZE = 512;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;
const TAR_TYPEFLAG_OFFSET = 156;
const TAR_FILENAME_OFFSET = 0;
const TAR_FILENAME_LENGTH = 100;
const MAX_REDIRECTS = 5;
const ALLOWED_GITHUB_HOSTS = ['github.com', 'api.github.com', 'codeload.github.com'];

const GITHUB_REPO_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)(?:\/.*)?$/;

export function isPublicGitHubRepoUrl(url: string): boolean {
  return GITHUB_REPO_URL_PATTERN.test(url);
}

export function parseGitHubRepoUrl(
  url: string,
): { owner: string; repo: string } | null {
  const match = url.match(GITHUB_REPO_URL_PATTERN);
  if (match === null) {
    return null;
  }
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

/**
 * Validates that a URL uses HTTPS and points to an approved GitHub host.
 * Only github.com, api.github.com, and codeload.github.com are permitted
 * for redirect targets. Rejects all other hosts.
 */
function isAllowedGitHubHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    return ALLOWED_GITHUB_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  let end = offset;
  const maxEnd = offset + length;
  while (end < maxEnd && buffer[end] !== 0) {
    end += 1;
  }
  return buffer.toString('ascii', offset, end);
}

function readTarFileSize(buffer: Buffer): number {
  const field = readTarString(buffer, TAR_SIZE_OFFSET, TAR_SIZE_LENGTH);
  return field.length === 0 ? 0 : parseInt(field, 8) || 0;
}

/**
 * Validates that a tar entry path is safe to extract.
 * Rejects absolute paths, ".." segments, and paths that resolve outside destDir.
 * Returns the resolved target path if safe, or null if unsafe.
 */
function safeResolveEntryPath(destDir: string, entryPath: string): string | null {
  // Reject absolute paths
  if (isAbsolute(entryPath)) {
    return null;
  }
  // Reject any ".." path segments
  const segments = entryPath.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      return null;
    }
  }
  // Resolve and verify containment within destDir
  const resolvedTarget = resolve(destDir, entryPath);
  const resolvedDest = resolve(destDir);
  // Ensure the resolved path starts with the destDir prefix (with separator)
  if (resolvedTarget !== resolvedDest && !resolvedTarget.startsWith(resolvedDest + '\\') && !resolvedTarget.startsWith(resolvedDest + '/')) {
    return null;
  }
  return resolvedTarget;
}

/**
 * Extracts an already-decompressed tar archive into destDir, enforcing the
 * path-safety and MAX_EXTRACTED_FILES limits. Exported only so the temporary
 * tar-security test can exercise the real implementation; it is not part of
 * the public API surface consumed by the app.
 */
export async function extractTarToDir(
  tarBuffer: Buffer,
  destDir: string,
): Promise<{ rootDirName: string; filesExtracted: number }> {
  let offset = 0;
  let rootDirName: string | null = null;
  let filesExtracted = 0;

  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    let allZero = true;
    for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      break;
    }
    const fileName = readTarString(header, TAR_FILENAME_OFFSET, TAR_FILENAME_LENGTH);
    if (fileName.length === 0) {
      offset += TAR_BLOCK_SIZE;
      continue;
    }
    const fileSize = readTarFileSize(header);
    const typeFlag = header[TAR_TYPEFLAG_OFFSET];
    const slashIndex = fileName.indexOf('/');
    if (slashIndex > 0 && rootDirName === null) {
      rootDirName = fileName.slice(0, slashIndex);
    }
    const dataStart = offset + TAR_BLOCK_SIZE;
    if (typeFlag === 0 || typeFlag === 48) {
      if (fileName.length > 0) {
        if (filesExtracted >= MAX_EXTRACTED_FILES) {
          throw new Error(`Aborted extraction: archive exceeds maximum of ${MAX_EXTRACTED_FILES} files.`);
        }
        const safePath = safeResolveEntryPath(destDir, fileName);
        if (safePath === null) {
          throw new Error(`Aborted extraction: tar entry "${fileName}" is unsafe (path traversal attempt).`);
        }
        await mkdir(dirname(safePath), { recursive: true });
        await writeFile(safePath, tarBuffer.subarray(dataStart, dataStart + fileSize));
        filesExtracted += 1;
      }
    } else if (typeFlag === 53) {
      if (fileName.length > 0) {
        if (filesExtracted >= MAX_EXTRACTED_FILES) {
          throw new Error(`Aborted extraction: archive exceeds maximum of ${MAX_EXTRACTED_FILES} files.`);
        }
        const safePath = safeResolveEntryPath(destDir, fileName);
        if (safePath === null) {
          throw new Error(`Aborted extraction: tar entry "${fileName}" is unsafe (path traversal attempt).`);
        }
        await mkdir(safePath, { recursive: true });
        filesExtracted += 1;
      }
    }
    offset = dataStart + Math.ceil(fileSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return { rootDirName: rootDirName ?? '', filesExtracted };
}

/**
 * Resolves a redirect Location header against the current URL.
 * Returns an absolute URL string, or null if invalid.
 */
function resolveRedirectUrl(currentUrl: string, location: string): string | null {
  try {
    const resolved = new URL(location, currentUrl);
    return resolved.toString();
  } catch {
    return null;
  }
}

function downloadToBuffer(url: string, redirectCount: number = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!isAllowedGitHubHost(url)) {
      reject(new Error('GitHub fetch blocked: URL is not an allowed GitHub host.'));
      return;
    }
    if (redirectCount > MAX_REDIRECTS) {
      reject(new Error('GitHub fetch blocked: too many redirects.'));
      return;
    }
    const req = get(
      url,
      {
        headers: { 'User-Agent': 'Proofline/0.1.0', Accept: 'application/gzip, */*' },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const loc = res.headers.location;
          if (typeof loc === 'string' && loc.length > 0) {
            res.resume();
            const redirectUrl = resolveRedirectUrl(url, loc);
            if (redirectUrl === null) {
              reject(new Error('GitHub fetch blocked: invalid redirect URL.'));
              return;
            }
            if (!isAllowedGitHubHost(redirectUrl)) {
              reject(new Error('GitHub fetch blocked: redirect to disallowed host.'));
              return;
            }
            downloadToBuffer(redirectUrl, redirectCount + 1).then(resolve, reject);
            return;
          }
        }
        if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`GitHub fetch failed with status ${res.statusCode ?? 'unknown'}.`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > MAX_TAR_SIZE_BYTES) {
            res.destroy();
            reject(new Error('Repository archive exceeds maximum allowed size.'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub fetch timed out.')); });
    req.on('error', reject);
  });
}

/**
 * Fetches JSON from a URL using node:https.
 * Follows redirects only to approved GitHub hosts (max MAX_REDIRECTS).
 * Returns the parsed JSON object.
 * Used for querying GitHub's public repository API.
 */
function fetchJsonFromUrl(url: string, redirectCount: number = 0): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!isAllowedGitHubHost(url)) {
      reject(new Error('GitHub API blocked: URL is not an allowed GitHub host.'));
      return;
    }
    if (redirectCount > MAX_REDIRECTS) {
      reject(new Error('GitHub API blocked: too many redirects.'));
      return;
    }
    const req = get(
      url,
      {
        headers: {
          'User-Agent': 'Proofline/0.1.0',
          Accept: 'application/vnd.github+json',
        },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const loc = res.headers.location;
          if (typeof loc === 'string' && loc.length > 0) {
            res.resume();
            const redirectUrl = resolveRedirectUrl(url, loc);
            if (redirectUrl === null) {
              reject(new Error('GitHub API blocked: invalid redirect URL.'));
              return;
            }
            if (!isAllowedGitHubHost(redirectUrl)) {
              reject(new Error('GitHub API blocked: redirect to disallowed host.'));
              return;
            }
            fetchJsonFromUrl(redirectUrl, redirectCount + 1).then(resolve, reject);
            return;
          }
        }
        if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`GitHub API request failed with status ${res.statusCode ?? 'unknown'}.`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > 1024 * 1024) {
            res.destroy();
            reject(new Error('GitHub API response too large.'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
            resolve(json);
          } catch {
            reject(new Error('Failed to parse GitHub API response.'));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API request timed out.')); });
    req.on('error', reject);
  });
}

/**
 * Determines the default branch of a public GitHub repository using
 * the public GitHub API (no authentication required).
 * Returns the branch name (e.g. 'main', 'master', 'develop').
 */
async function getDefaultBranch(owner: string, repo: string): Promise<string> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const json = await fetchJsonFromUrl(apiUrl);
  const defaultBranch = json.default_branch;
  if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) {
    throw new Error('GitHub API response did not include a valid default branch.');
  }
  return defaultBranch;
}

export async function fetchPublicGitHubRepository(repoUrl: string): Promise<string> {
  const parsed = parseGitHubRepoUrl(repoUrl);
  if (parsed === null) {
    throw new Error('Invalid public GitHub repository URL. Expected format: https://github.com/owner/repo.');
  }
  const { owner, repo } = parsed;

  // Determine the repository's actual default branch via the public GitHub API.
  const defaultBranch = await getDefaultBranch(owner, repo);
  const archiveUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${defaultBranch}.tar.gz`;

  let tarGz: Buffer;
  try {
    tarGz = await downloadToBuffer(archiveUrl);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error';
    throw new Error(`Failed to fetch public repository: ${message}`);
  }
  let tar: Buffer;
  try { tar = gunzipSync(tarGz); }
  catch (e) { throw new Error(`Failed to decompress repository archive: ${e instanceof Error ? e.message : 'unknown error'}.`); }
  if (tar.length > MAX_TAR_SIZE_BYTES) {
    throw new Error('Repository archive exceeds maximum allowed size.');
  }

  // Create a unique temporary extraction directory for this fetch.
  const extractDir = await mkdtemp(join(tmpdir(), 'proofline-repo-'));

  // extractTarToDir is now async and awaits all mkdir/writeFile calls.
  // If extraction fails (e.g., unsafe path), clean up the temp directory.
  let extractResult: { rootDirName: string; filesExtracted: number };
  try {
    extractResult = await extractTarToDir(tar, extractDir);
  } catch (e) {
    await rm(extractDir, { recursive: true, force: true });
    throw e;
  }

  const { rootDirName } = extractResult;
  if (rootDirName.length === 0) {
    await rm(extractDir, { recursive: true, force: true });
    throw new Error('Repository archive contains no files.');
  }
  return join(extractDir, rootDirName);
}
