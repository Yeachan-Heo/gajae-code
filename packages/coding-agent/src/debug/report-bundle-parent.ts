/** True when a session header names this parent file or its basename. */
export function sessionBelongsToParent(headerLine: string, parentBasename: string): boolean {
	let parentSession: unknown;
	try {
		parentSession = (JSON.parse(headerLine) as { parentSession?: unknown }).parentSession;
	} catch {
		return false;
	}
	if (typeof parentSession !== "string" || parentSession.length === 0) return false;
	const normalized = parentSession.replaceAll("\\", "/");
	const base =
		normalized
			.split("/")
			.pop()
			?.replace(/\.jsonl$/, "") ?? "";
	return (
		normalized === parentBasename ||
		base === parentBasename ||
		normalized.endsWith(`/${parentBasename}`) ||
		normalized.endsWith(`/${parentBasename}.jsonl`)
	);
}
