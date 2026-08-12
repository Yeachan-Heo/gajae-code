import { type RunGh, runGhDefault } from "../../../utils/gh";

const STATUS_LINE_GH_TIMEOUT_MS = 5_000;
const STATUS_LINE_PR_CACHE_TTL_MS = 60_000;
const C0_C1_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
type CurrentPr = { number: number; url: string } | null;

interface PrCacheEntry {
	value: CurrentPr;
	expiresAt: number;
}

const prCache = new Map<string, PrCacheEntry>();
const prLookupsInFlight = new Map<string, Promise<CurrentPr>>();

function canonicalPrUrl(value: unknown, number: number): string | null {
	if (typeof value !== "string" || C0_C1_CONTROL_CHARACTERS.test(value)) return null;

	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (!url.hostname || url.username || url.password || url.search || url.hash) return null;

		const suffix = `/pull/${number}`;
		if (!url.pathname.endsWith(suffix)) return null;
		const repositoryPath = url.pathname.slice(1, -suffix.length).split("/");
		if (repositoryPath.length !== 2 || repositoryPath.some(component => component === "")) return null;

		return url.href;
	} catch {
		return null;
	}
}

export async function lookupCurrentPr(runGh: RunGh = runGhDefault): Promise<CurrentPr> {
	try {
		const result = await runGh(["pr", "view", "--json", "number,url"], { timeoutMs: STATUS_LINE_GH_TIMEOUT_MS });
		if (result.exitCode !== 0 || result.timedOut) return null;

		const pr = JSON.parse(result.stdout) as { number?: unknown; url?: unknown };
		if (typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number <= 0) return null;
		const url = canonicalPrUrl(pr.url, pr.number);
		return url ? { number: pr.number, url } : null;
	} catch {
		return null;
	}
}

export function lookupCurrentPrCached(
	cacheKey: string,
	runGh: RunGh = runGhDefault,
	now: () => number = Date.now,
): Promise<CurrentPr> {
	const cached = prCache.get(cacheKey);
	if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);

	const inFlight = prLookupsInFlight.get(cacheKey);
	if (inFlight) return inFlight;

	const lookup = lookupCurrentPr(runGh)
		.then(value => {
			// Bound process-lifetime memory: drop every expired entry on insert so
			// the map holds only keys seen within one TTL window.
			const timestamp = now();
			for (const [key, entry] of prCache) {
				if (entry.expiresAt <= timestamp) prCache.delete(key);
			}
			prCache.set(cacheKey, { value, expiresAt: timestamp + STATUS_LINE_PR_CACHE_TTL_MS });
			return value;
		})
		.finally(() => {
			if (prLookupsInFlight.get(cacheKey) === lookup) prLookupsInFlight.delete(cacheKey);
		});
	prLookupsInFlight.set(cacheKey, lookup);
	return lookup;
}

export function clearCurrentPrCache(): void {
	prCache.clear();
	prLookupsInFlight.clear();
}
