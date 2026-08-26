/**
 * Keep provider and upstream failure text safe for less-trusted surfaces.
 *
 * This intentionally mirrors the bounded reason scrubber used by the account
 * management CLI without taking a dependency on coding-agent.
 */
export function cleanReason(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	let reason = value instanceof Error ? value.message : String(value);
	if (/[\u0000-\u001f\u007f-\u009f]/.test(reason)) return "Credential diagnostic unavailable.";
	if (reason.includes("\\")) return "Credential diagnostic unavailable.";
	if (/["']?authorization(?:[_-]header)?["']?\s*[:=]/i.test(reason)) return "Credential diagnostic unavailable.";
	if (
		/\b["']?(?:key|api[_-]?key|client[_-]?secret|clientSecret|token|secret|password|access|refresh|cookie|credential)(?:[_-](?:token|key|secret|header|headers))?["']?\s*[:=]/i.test(
			reason,
		)
	) {
		return "Credential diagnostic unavailable.";
	}
	if (/\b(?:bearer|basic)\s+["']/i.test(reason)) return "Credential diagnostic unavailable.";
	if (/^No credential with id=\d+$/i.test(reason)) return reason;
	if (/\b(?:api\s*[-_]?key|access\s*[-_]?token|refresh\s*[-_]?token|credential)\b/i.test(reason))
		return "Credential diagnostic unavailable.";
	reason = reason.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
	reason = reason.replace(/basic\s+[^\s,;]+/gi, "Basic [redacted]");
	reason = reason.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@");
	reason = reason.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s<>"']*?)(?:[?#][^\s<>"']*)/gi, "$1");
	reason = reason.replace(
		/((?:\\?["']?(?:key|api[_-]?key|client[_-]?secret|clientSecret|token|secret|authorization|password|access|refresh|cookie|credential)(?:[_-](?:token|key|secret|header|headers))?\\?["']?)\s*:\s*)\\?(["'])(?:\\.|(?!\2)[^\\])*\2/gi,
		"$1$2[redacted]$2",
	);
	reason = reason.replace(
		/((?:key|api[_-]?key|client[_-]?secret|clientSecret|token|secret|authorization|password|access|refresh|cookie|credential)(?:[_-](?:token|key|secret|header|headers))?)\s*[:=]\s*[^\s,;]+/gi,
		"$1=[redacted]",
	);
	reason = reason.replace(/[\r\n\t ]+/g, " ").trim();
	if (reason.length > 256) reason = `${reason.slice(0, 253)}...`;
	return reason || undefined;
}
