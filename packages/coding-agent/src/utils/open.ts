/** Open an http(s) URL or local path. Best-effort, never throws. */
const ALLOWED_OPEN_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Zero-width and non-ASCII spaces. ASCII controls are rejected, not stripped:
 * the URL parser drops some of them and would turn a hostile string into a clean href.
 */
const OUTER_FORMAT = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF\u200B\u2060]/;

function hasAsciiControl(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function isOuterPadding(ch: string): boolean {
	return ch.trim() === "" || OUTER_FORMAT.test(ch);
}

/** Drop every outer space or format character. Classification only; local paths stay raw. */
function peelPadding(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && isOuterPadding(value.charAt(start))) start++;
	while (end > start && isOuterPadding(value.charAt(end - 1))) end--;
	return start === 0 && end === value.length ? value : value.slice(start, end);
}

/** Drive paths parse as one-letter schemes (`c:`). Recognize them before that check. */
function isWindowsDrivePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value);
}

const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** http(s) href, "reject" for any other URL, or undefined when `value` is not a URL. */
function classifyUrl(value: string): string | "reject" | undefined {
	if (isWindowsDrivePath(value) || isWindowsDrivePath(value.trim())) return undefined;
	try {
		const parsed = new URL(value);
		if (!ALLOWED_OPEN_PROTOCOLS.has(parsed.protocol) || hasAsciiControl(parsed.href)) return "reject";
		return parsed.href;
	} catch {
		return undefined;
	}
}

function resolveOpenTarget(raw: string): string | undefined {
	if (hasAsciiControl(raw) || raw.length === 0) return undefined;
	// Local paths, including surrounding spaces, are spawned unchanged.
	if (isWindowsDrivePath(raw)) return raw;
	const direct = classifyUrl(raw);
	if (direct === "reject") return undefined;
	if (direct !== undefined) return direct;

	const peeled = peelPadding(raw);
	if (peeled.length === 0) return undefined;
	// Padding can hide a scheme or a flag. Refuse that instead of opening a different string.
	if (peeled !== raw && !isWindowsDrivePath(peeled)) {
		const hidden = classifyUrl(peeled);
		if (hidden !== undefined || peeled.startsWith("-") || SCHEME_PREFIX.test(peeled)) return undefined;
	}
	if (raw.startsWith("-") || SCHEME_PREFIX.test(raw)) return undefined;
	return raw;
}

export function openPath(urlOrPath: string): void {
	const target = resolveOpenTarget(urlOrPath);
	if (target === undefined) return;
	let cmd: string[];
	switch (process.platform) {
		case "darwin":
			cmd = ["open", target];
			break;
		case "win32":
			cmd = ["rundll32", "url.dll,FileProtocolHandler", target];
			break;
		default:
			cmd = ["xdg-open", target];
			break;
	}
	try {
		Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	} catch {
		// Best-effort: browser opening is non-critical
	}
}
