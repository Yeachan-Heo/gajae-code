const REDACTED = "<redacted>";
const SENSITIVE_KEY_PATTERN = /(?:token|secret|key|credential|password|authorization|auth|bearer|cookie|session)/i;

export function redactMCPEndpoint(value: string | undefined): string | undefined {
	if (!value) return value;
	try {
		const url = new URL(value);
		if (url.username) url.username = REDACTED;
		if (url.password) url.password = REDACTED;
		if (url.pathname !== "/") url.pathname = `/${REDACTED}`;
		for (const key of Array.from(url.searchParams.keys())) {
			url.searchParams.set(key, REDACTED);
		}
		url.hash = "";
		return url.toString();
	} catch {
		return REDACTED;
	}
}

export function redactMCPDiagnosticValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactMCPDiagnosticValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactMCPDiagnosticValue(entry),
		]),
	);
}
