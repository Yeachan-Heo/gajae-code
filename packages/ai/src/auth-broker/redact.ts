/**
 * Keep provider and upstream failure text safe for less-trusted surfaces.
 *
 * This intentionally mirrors the bounded reason scrubber used by the account
 * management CLI without taking a dependency on coding-agent.
 */
export function cleanReason(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	let reason = value instanceof Error ? value.message : String(value);
	reason = reason.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
	reason = reason.replace(/basic\s+[^\s,;]+/gi, "Basic [redacted]");
	reason = reason.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@");
	reason = reason.replace(
		/(["']?(?:api[_-]?key|token|secret|authorization|password|access|refresh|cookie|credential)(?:[_-](?:token|key|secret))?["']?)\s*[:=]\s*["']?[^\s,;"'}]+["']?/gi,
		"$1=[redacted]",
	);
	reason = reason.replace(/[\r\n\t ]+/g, " ").trim();
	if (reason.length > 256) reason = `${reason.slice(0, 253)}...`;
	return reason || undefined;
}
