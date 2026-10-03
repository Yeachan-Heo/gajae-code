/**
 * Grok CLI version manager with 426 error handling.
 *
 * Tracks the Grok CLI version learned from xAI with a hardcoded fallback and
 * handles HTTP 426 "version outdated" responses from xAI.
 */

const FALLBACK_VERSION = '1.0.13';
// Minimum version xAI demanded in its last HTTP 426 response. A server-stated
// minimum never becomes less true, so it has no expiry.
let learnedVersion: string | null = null;

/**
 * Get the current Grok CLI version: the version learned from the most recent
 * HTTP 426 response (see `updateVersionFromError`, called from the stream.ts
 * fetch wrapper), otherwise the fallback version.
 */
export function getGrokCliVersion(): string {
  return learnedVersion ?? FALLBACK_VERSION;
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
    learnedVersion = minVersion;
    return minVersion;
  }
  return FALLBACK_VERSION;
}

/**
 * Reset the version cache (mainly for testing).
 */
export function resetVersionCache(): void {
  learnedVersion = null;
}

/**
 * Get the fallback version (mainly for testing).
 */
export function getFallbackVersion(): string {
  return FALLBACK_VERSION;
}
