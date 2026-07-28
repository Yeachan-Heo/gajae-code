import { type RunGh, runGhDefault } from "../../../utils/gh";

const STATUS_LINE_GH_TIMEOUT_MS = 5_000;

export async function lookupCurrentPr(runGh: RunGh = runGhDefault): Promise<{ number: number; url: string } | null> {
	try {
		const result = await runGh(["pr", "view", "--json", "number,url"], { timeoutMs: STATUS_LINE_GH_TIMEOUT_MS });
		if (result.exitCode !== 0 || result.timedOut) return null;

		const pr = JSON.parse(result.stdout) as { number?: unknown; url?: unknown };
		if (typeof pr.number !== "number" || typeof pr.url !== "string") return null;
		return { number: pr.number, url: pr.url };
	} catch {
		return null;
	}
}
