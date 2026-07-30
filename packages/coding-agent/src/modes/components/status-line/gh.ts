import { type RunGh, runGhDefault } from "../../../utils/gh";

const STATUS_LINE_GH_TIMEOUT_MS = 5_000;

const C0_C1_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const isSafePrNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const hasAbsoluteHttpUrl = (value: unknown): value is string => {
	if (typeof value !== "string") return false;
	if (C0_C1_CONTROL_CHARACTERS.test(value)) return false;

	try {
		const parsed = new URL(value);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== "";
	} catch {
		return false;
	}
};

export async function lookupCurrentPr(runGh: RunGh = runGhDefault): Promise<{ number: number; url: string } | null> {
	try {
		const result = await runGh(["pr", "view", "--json", "number,url"], { timeoutMs: STATUS_LINE_GH_TIMEOUT_MS });
		if (result.exitCode !== 0 || result.timedOut) return null;

		const pr = JSON.parse(result.stdout) as { number?: unknown; url?: unknown };
		if (!isSafePrNumber(pr.number) || !hasAbsoluteHttpUrl(pr.url)) return null;
		return { number: pr.number, url: pr.url };
	} catch {
		return null;
	}
}
