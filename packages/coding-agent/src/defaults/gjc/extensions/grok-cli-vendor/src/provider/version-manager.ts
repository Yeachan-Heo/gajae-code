/**
 * Grok CLI version manager with 426 error handling.
 *
 * Learns the minimum required Grok CLI version from xAI HTTP 426 "version outdated" responses.
 * Falls back to a hardcoded version if no 426 has been received.
 * Version updates are monotonic: learned versions never downgrade.
 */

const FALLBACK_VERSION = '1.0.13';

// Minimum version xAI demanded in its latest HTTP 426 response.
// A server-stated minimum never becomes less true, so it has no expiry.
let learnedVersion: string | null = null;

/**
 * Get the current Grok CLI version: learned from 426 responses (never downgrades),
 * otherwise the fallback version.
 */
export function getGrokCliVersion(): string {
  return learnedVersion ?? FALLBACK_VERSION;
}

/**
 * Parse a minimum version from an HTTP 426 error response body.
 * Expected format: "Your Grok CLI version (X.Y.Z) is outdated. Please update to version A.B.C or later"
 */
export function parseMinimumVersionFrom426(errorBody: string): string | null {
  const versionMatch = errorBody.match(/update to version (\d+\.\d+\.\d+) or later\b/i);
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

  // Compare against the active value so an older minimum cannot downgrade the fallback.
  if (isVersionGreater(minVersion, getGrokCliVersion())) {
    learnedVersion = minVersion;
  }

  return getGrokCliVersion();
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
 * Reset the learned version (mainly for testing).
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
