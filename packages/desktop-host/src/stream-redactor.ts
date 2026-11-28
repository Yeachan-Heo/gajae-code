const MAX_SECRET_LENGTH = 65_536;
const REDACTION_MARKER = "[redacted]";
const FAILURE_MESSAGE = "Desktop stream redaction failed; output was withheld.";
const MAX_CONTROL_LENGTH = 4_096;

/**
 * Frame controls before using Bun's whole-text ANSI stripper. Incomplete controls
 * never reach it: stripping an ESC alone would expose its payload on the next push.
 * Only a bounded control is retained, never the surrounding printable text.
 */
function createDesktopTerminalNormalizer(): { push(chunk: string): string; finish(): string } {
	let control = "";
	let mode: "text" | "escape" | "escapeIntermediate" | "csi" | "csiIntermediate" | "osc" | "string" | "stringEscape" =
		"text";
	let closed = false;

	function fail(): never {
		closed = true;
		control = "";
		throw new Error(FAILURE_MESSAGE);
	}

	return {
		push(chunk) {
			if (closed || typeof chunk !== "string") return fail();
			const parts: string[] = [];
			let start = 0;
			for (let index = 0; index < chunk.length; index++) {
				const unit = chunk.charCodeAt(index);
				if (mode === "text") {
					if (unit === 0x1b || (unit >= 0x80 && unit <= 0x9f)) {
						parts.push(chunk.slice(start, index));
						start = index + 1;
						if (unit === 0x1b) mode = "escape";
						else if (unit === 0x9b) mode = "csi";
						else if (unit === 0x9d) mode = "osc";
						else if ([0x90, 0x98, 0x9e, 0x9f].includes(unit)) mode = "string";
						if (mode !== "text") control = chunk[index]!;
					}
					continue;
				}
				start = index + 1;
				control += chunk[index];
				if (control.length > MAX_CONTROL_LENGTH) return fail();
				if (mode === "escape") {
					if (unit === 0x5b) mode = "csi";
					else if (unit === 0x5d) mode = "osc";
					else if ([0x50, 0x58, 0x5e, 0x5f].includes(unit)) mode = "string";
					else if (unit >= 0x20 && unit <= 0x2f) mode = "escapeIntermediate";
					else if (unit >= 0x30 && unit <= 0x7e) mode = "text";
					else return fail();
				} else if (mode === "escapeIntermediate") {
					if (unit >= 0x30 && unit <= 0x7e) mode = "text";
					else if (unit < 0x20 || unit > 0x2f) return fail();
				} else if (mode === "csi" || mode === "csiIntermediate") {
					if (unit >= 0x40 && unit <= 0x7e) mode = "text";
					else if (unit >= 0x20 && unit <= 0x2f) mode = "csiIntermediate";
					else if (mode !== "csi" || unit < 0x30 || unit > 0x3f) return fail();
				} else if (mode === "stringEscape") {
					if (unit !== 0x5c) return fail();
					mode = "text";
				} else if (unit === 0x9c || (mode === "osc" && unit === 0x07)) mode = "text";
				else if (unit === 0x1b) {
					mode = "stringEscape";
				}
				if (mode === "text") {
					// Bun handles complete CSI/ESC controls; string controls are opaque
					// payloads (including multiline OSC), so discard them in full.
					if (!/^(?:\x1b(?:\]|[PX^_])|[\x90\x98\x9d-\x9f])/.test(control)) {
						const ansi = control.startsWith("\x9b") ? `\x1b[${control.slice(1)}` : control;
						if (Bun.stripANSI(ansi).replace(/[\x00-\x1f\x7f-\x9f]/g, "")) return fail();
					}
					control = "";
				}
			}
			parts.push(chunk.slice(start));
			return parts.join("").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
		},
		finish() {
			if (closed || mode !== "text") return fail();
			closed = true;
			return "";
		},
	};
}

export function normalizeDesktopTerminalText(text: string): string {
	const normalizer = createDesktopTerminalNormalizer();
	return normalizer.push(text) + normalizer.finish();
}

function highSurrogate(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}

function lowSurrogate(unit: number): boolean {
	return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Masks the construction-time secret snapshot before callers truncate output.
 * Secrets learned after text has been emitted cannot be protected retroactively.
 * The callback supplements known-secret masking; it is not a chunk-boundary policy.
 */
export function createDesktopStreamRedactor(
	secrets: readonly string[],
	redact: (text: string) => string,
): { push(chunk: string): string; finish(): string } {
	if (!Array.isArray(secrets) || typeof redact !== "function") throw new Error(FAILURE_MESSAGE);
	const knownSecrets = new Set<string>();
	const rawSecrets = new Set<string>();
	let overlap = 0;
	let rawOverlap = 0;
	for (const secret of secrets) {
		if (typeof secret !== "string" || secret.length > MAX_SECRET_LENGTH) throw new Error(FAILURE_MESSAGE);
		if (!secret.length) continue;
		const normalized = normalizeDesktopTerminalText(secret);
		if (!normalized.length) throw new Error(FAILURE_MESSAGE);
		knownSecrets.add(normalized);
		rawSecrets.add(secret);
		rawOverlap = Math.max(rawOverlap, secret.length - 1);
		// Also retain enough visible text for a raw match crossing a control's
		// boundary: normalization may consume the beginning of that credential.
		overlap = Math.max(overlap, secret.length - 1);
	}

	const normalizer = createDesktopTerminalNormalizer();
	let rawTail = "";
	let rawMatched = false;
	let transformed = false;
	let pending = "";
	let pendingMasks = new Uint8Array(0);
	let maskedRegion = false;
	let state: "open" | "processing" | "finished" | "failed" = "open";

	function fail(): never {
		state = "failed";
		rawTail = "";
		pending = "";
		pendingMasks = new Uint8Array(0);
		throw new Error(FAILURE_MESSAGE);
	}

	function consume(chunk: string, final: boolean): string {
		try {
			if (state !== "open" || typeof chunk !== "string") return fail();
			state = "processing";
			const normalized = normalizer.push(chunk) + (final ? normalizer.finish() : "");
			transformed ||= normalized !== chunk;
			const probe = rawTail + chunk;
			if (!rawMatched) {
				for (const secret of rawSecrets) {
					if (probe.includes(secret)) {
						rawMatched = true;
						break;
					}
				}
			}
			// A raw credential can begin inside a stripped control (e.g. "31mkey"
			// in ESC[31mkey). Its visible suffix is not a normalized literal match.
			// Withhold rather than destructively mask raw input and lose overlaps.
			if (transformed && rawMatched) return fail();
			rawTail = rawOverlap && !final ? probe.slice(-rawOverlap) : "";
			const raw = pending + normalized;
			const masks = new Uint8Array(raw.length);
			masks.set(pendingMasks);
			for (const secret of knownSecrets) {
				let start = raw.indexOf(secret);
				while (start !== -1) {
					masks.fill(1, start, start + secret.length);
					// Advance one UTF-16 unit, not a whole match: matches can overlap.
					start = raw.indexOf(secret, start + 1);
				}
			}
			// Even a secret containing only half a surrogate must not split a pair.
			for (let index = 0; index + 1 < raw.length; index++) {
				if (
					highSurrogate(raw.charCodeAt(index)) &&
					lowSurrogate(raw.charCodeAt(index + 1)) &&
					(masks[index] || masks[index + 1])
				) {
					masks[index] = 1;
					masks[index + 1] = 1;
				}
			}

			let release = final ? raw.length : Math.max(0, raw.length - overlap);
			if (
				!final &&
				release > 0 &&
				highSurrogate(raw.charCodeAt(release - 1)) &&
				(release === raw.length || lowSurrogate(raw.charCodeAt(release)))
			) {
				release--;
			}
			const parts: string[] = [];
			let index = 0;
			while (index < release) {
				if (masks[index]) {
					if (!maskedRegion) parts.push(REDACTION_MARKER);
					maskedRegion = true;
					index++;
				} else {
					const start = index;
					while (index < release && !masks[index]) index++;
					parts.push(raw.slice(start, index));
					maskedRegion = false;
				}
			}
			// Keep raw overlap AND its masks: a match may extend into later releases.
			// Pending is at most overlap + one UTF-16 unit (a surrogate boundary).
			pending = raw.slice(release);
			pendingMasks = masks.slice(release);
			const safe = parts.join("");
			const result: unknown = safe ? redact(safe) : "";
			// A throwing, invalid, or reentrant callback poisons this stream permanently.
			if (typeof result !== "string" || state !== "processing") return fail();
			state = final ? "finished" : "open";
			return result;
		} catch {
			return fail();
		}
	}

	return {
		push(chunk) {
			return consume(chunk, false);
		},
		finish() {
			return consume("", true);
		},
	};
}
