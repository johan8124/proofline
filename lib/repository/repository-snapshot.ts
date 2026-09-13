/**
 * Proofline repository snapshot — deterministic data model (foundation only).
 *
 * This module defines the typed representation of repository facts that
 * Proofline can later verify (repository accessibility, available files,
 * default branch, commit identifier).
 *
 * This module is DATA MODEL ONLY. It never fetches anything: no GitHub API
 * calls, no network requests, no filesystem inspection, no inference of
 * repository facts. Every snapshot contains facts supplied explicitly by
 * another layer; unknown values are represented with explicit unions or
 * `null`, never guessed.
 *
 * No Date.now(), Math.random(), UUID generation, or environment access.
 */

/**
 * Whether the repository itself could be reached/verified.
 * `verified` — a supplying layer confirmed the repository is accessible.
 * `inaccessible` — a supplying layer confirmed the repository is NOT reachable.
 * `unknown` — no supplying layer has determined accessibility.
 */
export type RepositoryAccessibility = 'verified' | 'inaccessible' | 'unknown';

/**
 * Whether a specific repository file is available.
 * `present` — a supplying layer observed the file.
 * `missing` — a supplying layer observed the file's absence.
 * `unknown` — the file's availability has not been determined.
 */
export type RepositoryFileAvailability = 'present' | 'missing' | 'unknown';

/**
 * Coarse category of a repository file. `other` catches anything the
 * supplying layer cannot classify; new categories extend this union.
 */
export type RepositoryFileCategory =
  | 'readme'
  | 'license'
  | 'source'
  | 'configuration'
  | 'artifact'
  | 'other';

/**
 * One file in a repository snapshot, as reported by a supplying layer.
 * The snapshot records the report; it never checks the filesystem itself.
 */
export interface RepositoryFile {
  /** Repository-relative path of the file (e.g. 'README.md', 'src/main.py'). */
  path: string;
  /** Coarse category of the file, assigned by the supplying layer. */
  category: RepositoryFileCategory;
  /** Availability of the file as reported by the supplying layer. */
  availability: RepositoryFileAvailability;
}

/**
 * A deterministic snapshot of repository facts, supplied by another layer.
 * Optional fields are `null` (never omitted-and-assumed) when the supplying
 * layer could not determine them, which lets future validators push affected
 * checks to 'unsupported' instead of guessing.
 */
export interface RepositorySnapshot {
  /** Repository URL (e.g. 'https://github.com/example/repo'). */
  repositoryUrl: string;
  /** Whether the repository could be reached/verified. */
  accessibility: RepositoryAccessibility;
  /** Files reported as part of the repository. */
  files: readonly RepositoryFile[];
  /** Default branch name, or `null` when not determined. */
  defaultBranch: string | null;
  /** Commit identifier (e.g. SHA) inspected, or `null` when not determined. */
  commitId: string | null;
}

// ---------------------------------------------------------------------------
// Deterministic examples (fixed values; no generated ids or timestamps)
// ---------------------------------------------------------------------------

/** Example files for the verified repository snapshot. */
export const EXAMPLE_VERIFIED_REPOSITORY_FILES: readonly RepositoryFile[] = [
  {
    path: 'README.md',
    category: 'readme',
    availability: 'present',
  },
  {
    path: 'LICENSE',
    category: 'license',
    availability: 'present',
  },
  {
    path: 'src/main.py',
    category: 'source',
    availability: 'present',
  },
  {
    path: 'figures/results.pdf',
    category: 'artifact',
    availability: 'present',
  },
] as const;

/**
 * Example 1: a verified repository with README, LICENSE, a source file, and a
 * supplementary artifact all present.
 */
export const EXAMPLE_VERIFIED_REPOSITORY_SNAPSHOT: RepositorySnapshot = {
  repositoryUrl: 'https://github.com/example/proofline-verified',
  accessibility: 'verified',
  files: EXAMPLE_VERIFIED_REPOSITORY_FILES,
  defaultBranch: 'main',
  commitId: 'a1234567890abcdef1234567890abcdef1234567',
};

/**
 * Example 2: an inaccessible repository. No file facts are available, so
 * every reported file is 'missing' and branch/commit remain unknown.
 */
export const EXAMPLE_INACCESSIBLE_REPOSITORY_SNAPSHOT: RepositorySnapshot = {
  repositoryUrl: 'https://github.com/example/proofline-inaccessible',
  accessibility: 'inaccessible',
  files: [
    {
      path: 'README.md',
      category: 'readme',
      availability: 'missing',
    },
  ],
  defaultBranch: null,
  commitId: null,
};

/**
 * Example 3: a reachable repository whose file availability has not been
 * determined by any supplying layer.
 */
export const EXAMPLE_UNKNOWN_AVAILABILITY_REPOSITORY_SNAPSHOT: RepositorySnapshot = {
  repositoryUrl: 'https://github.com/example/proofline-unknown',
  accessibility: 'unknown',
  files: [
    {
      path: 'README.md',
      category: 'readme',
      availability: 'unknown',
    },
    {
      path: 'LICENSE',
      category: 'license',
      availability: 'unknown',
    },
  ],
  defaultBranch: null,
  commitId: null,
};
