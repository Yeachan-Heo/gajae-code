import { type RunGh, runGhDefault } from "../../../utils/gh";

const STATUS_LINE_GH_TIMEOUT_MS = 5_000;
const C0_C1_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

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

export async function lookupCurrentPr(runGh: RunGh = runGhDefault): Promise<{ number: number; url: string } | null> {
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
