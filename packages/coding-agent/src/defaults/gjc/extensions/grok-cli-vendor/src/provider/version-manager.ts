/**
 * Grok CLI version manager with 426 error handling.
 *
 * Resolves the Grok CLI version from GitHub releases with a 24-hour cache,
 * falls back to a hardcoded version if GitHub is unavailable,
 * and learns versions from xAI HTTP 426 "version outdated" responses.
 * Version updates are monotonic: learned versions never downgrade.
 */

const FALLBACK_VERSION = '1.0.13';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface VersionCache {
  version: string;
  timestamp: number;
}

// Minimum version xAI demanded in its last HTTP 426 response.
// A server-stated minimum never becomes less true, so it has no expiry.
let learnedVersion: string | null = null;

// Cached version from GitHub releases with timestamp for TTL tracking.
let versionCache: VersionCache | null = null;

// Background GitHub fetch promise to avoid concurrent requests.
let fetchPromise: Promise<string | null> | null = null;

/**
 * Fetch the latest Grok CLI version from GitHub releases.
 * Returns null if the fetch fails or times out.
 */
async function fetchLatestVersionFromGitHub(): Promise<string | null> {
  try {
    // Fetch latest release from xAI/grok-cli repository
    const response = await fetch(
      'https://api.github.com/repos/xai-org/grok-cli/releases/latest',
      { signal: AbortSignal.timeout(5000) }, // 5 second timeout
    );

    if (!response.ok) return null;

    const data = (await response.json()) as { tag_name?: string };
    // Extract version from tag name (e.g., "v1.0.20" -> "1.0.20")
    const tag = data.tag_name;
    if (tag && typeof tag === 'string') {
      return tag.replace(/^v/, '');
    }
    return null;
  } catch {
    // Network errors, timeouts, and JSON parse errors all return null
    return null;
  }
}

/**
 * Get the current Grok CLI version: learned from 426 responses (never downgrades),
 * then cached from GitHub (with 24-hour TTL), otherwise the fallback version.
 * The GitHub fetch happens in the background on first call and does not block.
 */
export function getGrokCliVersion(): string {
  // Learned versions (from 426 errors) have priority and never expire
  if (learnedVersion) {
    return learnedVersion;
  }

  // Check if cached version is still fresh
  if (versionCache) {
    const age = Date.now() - versionCache.timestamp;
    if (age < CACHE_TTL_MS) {
      return versionCache.version;
    }
  }

  // Return the last known cached version (stale but better than fallback)
  // while a fresh fetch happens in the background
  if (versionCache) {
    startBackgroundVersionFetch();
    return versionCache.version;
  }

  // No cached version and no learned version: start background fetch
  startBackgroundVersionFetch();
  return FALLBACK_VERSION;
}

/**
 * Trigger a background GitHub version fetch without blocking the caller.
 * Prevents concurrent fetch requests by tracking the promise.
 */
function startBackgroundVersionFetch(): void {
  // Avoid concurrent GitHub fetches
  if (fetchPromise) return;

  fetchPromise = fetchLatestVersionFromGitHub()
    .then((freshVersion) => {
      // Cache the fetched version if successful
      if (freshVersion) {
        versionCache = { version: freshVersion, timestamp: Date.now() };
      }
      return freshVersion;
    })
    .finally(() => {
      // Allow the next fetch to proceed
      fetchPromise = null;
    });
}

/**
 * Parse a minimum version from an HTTP 426 error response body.
 * Expected format: "Your Grok CLI version (X.Y.Z) is outdated. Please update to version A.B.C or later"
 */
export function parseMinimumVersionFrom426(errorBody: string): string | null {
  const versionMatch = errorBody.match(/update to version (\S+) or later/i);
  return versionMatch?.[1] ?? null;
}

/**
 * Update the learned version from a 426 error response.
 * Versions are monotonic: a learned version never downgrades.
 * Returns the version to use for the next request.
 */
export function updateVersionFromError(errorBody: string): string {
  const minVersion = parseMinimumVersionFrom426(errorBody);
  if (!minVersion) {
    return getGrokCliVersion();
  }

  // Only update if this is a newer version (monotonic constraint)
  if (!learnedVersion || isVersionGreater(minVersion, learnedVersion)) {
    learnedVersion = minVersion;
  }

  return learnedVersion;
}

/**
 * Determine if version1 is greater than version2 (naive semver comparison).
 * Prevents learned versions from downgrading due to out-of-order 426 responses.
 */
function isVersionGreater(version1: string, version2: string): boolean {
  const parts1 = version1.split('.').map((x) => parseInt(x, 10) || 0);
  const parts2 = version2.split('.').map((x) => parseInt(x, 10) || 0);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] ?? 0;
    const p2 = parts2[i] ?? 0;
    if (p1 > p2) return true;
    if (p1 < p2) return false;
  }
  return false;
}

/**
 * Reset all version caches (mainly for testing).
 * Clears both the GitHub-fetched cache and the learned version from 426 errors.
 */
export function resetVersionCache(): void {
  learnedVersion = null;
  versionCache = null;
  // Note: we do NOT cancel fetchPromise here since it's an async background operation
  // and callers may need to await its completion to properly clear state
}

/**
 * Reset and wait for any pending background fetch to complete.
 * Used in tests to ensure clean state before assertions.
 */
export async function resetVersionCacheAndWaitForPending(): Promise<void> {
  resetVersionCache();
  if (fetchPromise) {
    try {
      await fetchPromise;
    } catch {
      // Ignore errors in pending fetch
    }
    fetchPromise = null;
  }
}

/**
 * Get the fallback version (mainly for testing).
 */
export function getFallbackVersion(): string {
  return FALLBACK_VERSION;
}
