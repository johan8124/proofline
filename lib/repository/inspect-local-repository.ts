/**
 * Proofline local repository collector — deterministic, read-only inspection.
 *
 * Builds a RepositorySnapshot by inspecting ONLY the supplied local directory
 * (its directory tree). This proves the repository verification pipeline
 * locally, before any GitHub/API integration exists. There is still no
 * network access, no GitHub call, no environment access, no file content
 * reads, no file creation/modification/deletion, no Git commands, and no
 * Git initialization.
 *
 * Detection policy (small, explicit, deterministic):
 *   - Directory traversal is breadth-first over real directories only
 *     (symlinked directories/files are ignored so traversal cannot escape
 *     the supplied root). '.git' and 'node_modules' are skipped, depth is
 *     capped at 8 and collected files at 10 000 to keep runs bounded.
 *   - Categories: 'README.md' → readme; 'LICENSE' or 'LICENSE.md' → license;
 *     extensions .ts .tsx .js .jsx .py .java .cpp .c .go .rs → source;
 *     extensions .pdf .zip .tar .gz .csv .json → artifact.
 *     Everything else ('other') is ignored for now.
 *   - File contents are never read; existence and directory structure are
 *     sufficient for every fact this collector reports.
 *
 * Fact representation (consistent with repository-snapshot.ts):
 *   - 'README.md' and 'LICENSE' are explicitly probed and always appear as a
 *     file entry with availability 'present' or 'missing'.
 *   - Source/artifact facts are the set of entries in those categories;
 *     no entry of a category means no such file was observed. This collector
 *     never reports 'unknown': it reports only what it directly observed.
 *   - Presence is determined over the whole inspected tree, so a README.md
 *     in any inspected subdirectory counts as present.
 *
 * Output: repositoryUrl = supplied argument, accessibility = 'verified' when
 * the directory is readable / 'inaccessible' when it is not, defaultBranch =
 * null and commitId = null (never inferred from the local directory). When
 * the directory cannot be read, no file facts are reported at all (files is
 * empty); the accessibility field carries the outcome.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  RepositoryFile,
  RepositoryFileCategory,
  RepositorySnapshot,
} from './repository-snapshot';

/** Extensions classified as source files. */
export const SOURCE_FILE_EXTENSIONS: readonly string[] = [
  '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.c', '.go', '.rs',
];

/** Extensions classified as artifact files. */
export const ARTIFACT_FILE_EXTENSIONS: readonly string[] = [
  '.pdf', '.zip', '.tar', '.gz', '.csv', '.json',
];

/** Explicitly probed file paths (always reported present or missing). */
export const PROBED_FILE_PATHS: readonly { path: string; category: RepositoryFileCategory }[] = [
  { path: 'README.md', category: 'readme' },
  { path: 'LICENSE', category: 'license' },
];

/** Directories never traversed by the local collector. */
const SKIPPED_DIRECTORY_NAMES: readonly string[] = ['.git', 'node_modules'];

/** Maximum traversal depth below the supplied directory (bounded runs). */
const MAX_DIRECTORY_DEPTH = 8;

/** Maximum number of files collected in one inspection (bounded runs). */
const MAX_COLLECTED_FILES = 10_000;

/** Returns the lowercase extension of a file name ('' when none). */
function fileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) {
    return '';
  }
  return fileName.slice(dotIndex).toLowerCase();
}

/**
 * Deterministic category policy. Exact names take precedence over
 * extensions; anything unclassified is ignored ('other' is not reported).
 */
function classifyRepositoryFile(
  fileName: string,
  extension: string,
): RepositoryFileCategory | undefined {
  if (fileName === 'README.md') {
    return 'readme';
  }
  if (fileName === 'LICENSE' || fileName === 'LICENSE.md') {
    return 'license';
  }
  if ((SOURCE_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    return 'source';
  }
  if ((ARTIFACT_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    return 'artifact';
  }
  return undefined;
}
/**
 * Walks the directory tree below `root` breadth-first and returns the
 * relative POSIX-style paths of all real files, bounded by the depth and
 * count caps. Read failures on subdirectories are skipped (deterministic);
 * a read failure on the root itself is rethrown so the caller can classify
 * the whole repository as inaccessible.
 *
 * Only the supplied root is traversed, and only real directories/files are
 * followed (symlinks are Dirents that are neither isDirectory nor isFile,
 * so traversal can never escape the root). Dirent reads never touch file
 * contents.
 */
async function collectRelativeFilePaths(root: string): Promise<string[]> {
  const collected: string[] = [];
  const queue: { absolute: string; relative: string; depth: number }[] = [
    { absolute: root, relative: '', depth: 0 },
  ];

  while (queue.length > 0 && collected.length < MAX_COLLECTED_FILES) {
    const current = queue.shift() as { absolute: string; relative: string; depth: number };
    let dirents;
    try {
      dirents = await readdir(current.absolute, { withFileTypes: true });
    } catch (error) {
      if (current.relative === '') {
        throw error; // Root unreadable → caller classifies as inaccessible.
      }
      continue; // Unreadable subdirectory: skip, keep the run deterministic.
    }

    for (const dirent of dirents) {
      if (collected.length >= MAX_COLLECTED_FILES) {
        break;
      }
      const relativePath =
        current.relative === '' ? dirent.name : current.relative + '/' + dirent.name;
      if (dirent.isDirectory()) {
        if (
          current.depth < MAX_DIRECTORY_DEPTH &&
          !SKIPPED_DIRECTORY_NAMES.includes(dirent.name)
        ) {
          queue.push({
            absolute: join(current.absolute, dirent.name),
            relative: relativePath,
            depth: current.depth + 1,
          });
        }
      } else if (dirent.isFile()) {
        collected.push(relativePath);
      }
    }
  }

  return collected;
}

/**
 * Appends a probed file entry with availability 'missing' unless the file
 * was already observed during traversal.
 */
function ensureProbedEntry(
  files: RepositoryFile[],
  path: string,
  category: RepositoryFileCategory,
): void {
  const observed = files.some((file) => file.path === path);
  if (!observed) {
    files.push({ path, category, availability: 'missing' });
  }
}

/**
 * Inspects ONLY the supplied local directory and returns a deterministic
 * RepositorySnapshot. Read-only: no file contents are read, nothing is
 * modified, created, deleted, or executed; no network, no Git, no
 * environment access.
 */
export async function inspectLocalRepository(
  directoryPath: string,
  repositoryUrl: string,
): Promise<RepositorySnapshot> {
  let relativeFilePaths: string[];
  try {
    relativeFilePaths = await collectRelativeFilePaths(directoryPath);
  } catch {
    // The directory itself cannot be read: report it as inaccessible and
    // report no file facts (this collector never guesses).
    return {
      repositoryUrl,
      accessibility: 'inaccessible',
      files: [],
      defaultBranch: null,
      commitId: null,
    };
  }

  const files: RepositoryFile[] = [];
  for (const relativePath of relativeFilePaths) {
    const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    const category = classifyRepositoryFile(fileName, fileExtension(fileName));
    if (category === undefined) {
      continue; // 'other' files are ignored for now.
    }
    files.push({ path: relativePath, category, availability: 'present' });
  }

  // Explicit probes: README.md and LICENSE are always reported as present
  // or missing (never unknown, never omitted).
  for (const probe of PROBED_FILE_PATHS) {
    ensureProbedEntry(files, probe.path, probe.category);
  }

  // Deterministic output ordering.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    repositoryUrl,
    accessibility: 'verified',
    files,
    defaultBranch: null,
    commitId: null,
  };
}

