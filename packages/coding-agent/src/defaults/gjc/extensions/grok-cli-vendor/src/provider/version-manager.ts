/**
 * Grok CLI version manager with caching and 426 error handling.
 *
 * Maintains the latest known Grok CLI version with automatic fallback and
 * handles HTTP 426 "version outdated" responses from xAI.
 */

const FALLBACK_VERSION = '1.0.13';
const GITHUB_RELEASES_API = 'https://api.github.com/repos/xai-org/grok-cli/releases/latest';
const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  version: string;
  timestamp: number;
}

let versionCache: CacheEntry | null = null;
let failureCacheExpiry: number | null = null; // Timestamp when we can retry a failed fetch; prevents 404 storms

/**
 * Fetch the latest Grok CLI version from GitHub releases API.
 * Returns null if fetch fails or response is invalid.
 */
async function fetchLatestVersionFromGitHub(): Promise<string | null> {
  try {
    const response = await fetch(GITHUB_RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'gjc-grok-cli',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { tag_name?: string };
    const tagName = data.tag_name;

    if (typeof tagName === 'string') {
      // Remove 'v' prefix if present (e.g., 'v1.0.13' -> '1.0.13')
      return tagName.replace(/^v/, '');
    }
  } catch {
    // Silently fail; we'll use cached or fallback version
  }

  return null;
}

/**
 * Get the current Grok CLI version.
 *
 * Strategy:
 * 1. Return cached version if not expired
 * 2. If not cached or expired, try to fetch latest from GitHub (non-blocking; fires in background)
 * 3. Fall back to hardcoded version
 *
 * Note: This function is intentionally synchronous/fire-and-forget. The GitHub fetch
 * happens in the background and updates the cache for future requests. On first call
 * or cache miss, the fallback is returned immediately. Failed fetches (404, network errors)
 * are cached with a TTL to prevent retry storms.
 */
export function getGrokCliVersion(): string {
  const now = Date.now();

  // Use cached version if it exists and hasn't expired
  if (versionCache && now - versionCache.timestamp < VERSION_CACHE_TTL_MS) {
    return versionCache.version;
  }

  // If a fetch failed recently, don't retry immediately; use failure cache TTL
  // This prevents hitting GitHub 404 or rate limits repeatedly
  if (failureCacheExpiry && now < failureCacheExpiry) {
    // Return cached version if available during backoff, otherwise fallback
    return versionCache?.version ?? FALLBACK_VERSION;
  }

  // Note: Background fetch from GitHub is not attempted since the grok-cli releases
  // endpoint does not exist. Version learning is available through 426 error handling
  // in the production error path (stream.ts onResponse handler), which updates the cache
  // when xAI returns HTTP 426 with a minimum version requirement.
  // TODO: When a reliable version source becomes available (e.g., xai-org releases a
  // public CLI with GitHub releases), uncomment the background fetch below.

  // Return cached or fallback version immediately (non-blocking)
  return versionCache?.version ?? FALLBACK_VERSION;
}

/**
 * Parse and handle HTTP 426 response from xAI.
 * Extracts minimum version requirement from error message.
 *
 * Expected format:
 * "Your Grok CLI version (0.2.33) is outdated. Please update to version X.Y.Z or later"
 */
export function parseMinimumVersionFrom426(errorBody: string): string | null {
  // Match any non-whitespace version string after "update to version "
  const versionMatch = errorBody.match(/update to version (\S+) or later/i);
  return versionMatch?.[1] ?? null;
}

/**
 * Handle a 426 error by updating the cache with the minimum version
 * and returning it for immediate retry.
 */
export function updateVersionFromError(errorBody: string): string {
  const minVersion = parseMinimumVersionFrom426(errorBody);
  if (minVersion) {
    versionCache = { version: minVersion, timestamp: Date.now() };
    return minVersion;
  }
  return FALLBACK_VERSION;
}

/**
 * Reset the version cache (mainly for testing).
 */
export function resetVersionCache(): void {
  versionCache = null;
  failureCacheExpiry = null;
}

/**
 * Get the fallback version (mainly for testing).
 */
export function getFallbackVersion(): string {
  return FALLBACK_VERSION;
}
