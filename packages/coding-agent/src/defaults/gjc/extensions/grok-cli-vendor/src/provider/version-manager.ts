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

/**
 * Fetch the latest Grok CLI version from GitHub releases API.
 * Returns null if fetch fails or response is invalid.
 */
async function fetchLatestVersionFromGitHub(): Promise<string | null> {
	try {
		const response = await fetch(GITHUB_RELEASES_API, {
			headers: {
				'Accept': 'application/vnd.github.v3+json',
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
 * 2. Try to fetch latest from GitHub (non-blocking; returns immediately if slow)
 * 3. Fall back to hardcoded version
 */
export async function getGrokCliVersion(): Promise<string> {
	const now = Date.now();

	// Use cached version if it exists and hasn't expired
	if (versionCache && now - versionCache.timestamp < VERSION_CACHE_TTL_MS) {
		return versionCache.version;
	}

	// Attempt to fetch latest version asynchronously
	// This is non-blocking; if it fails, we return the fallback
	fetchLatestVersionFromGitHub()
		.then((latestVersion) => {
			if (latestVersion) {
				versionCache = { version: latestVersion, timestamp: now };
			}
		})
		.catch(() => {
			// Silently ignore fetch errors
		});

	// Return cached, fallback, or current cached version
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
}

/**
 * Get the fallback version (mainly for testing).
 */
export function getFallbackVersion(): string {
	return FALLBACK_VERSION;
}
