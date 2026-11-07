const MAX_SECRET_LENGTH = 65_536;
const REDACTION_MARKER = "[redacted]";
const FAILURE_MESSAGE = "Desktop stream redaction failed; output was withheld.";

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
	let overlap = 0;
	for (const secret of secrets) {
		if (typeof secret !== "string" || secret.length > MAX_SECRET_LENGTH) throw new Error(FAILURE_MESSAGE);
		if (!secret.length) continue;
		knownSecrets.add(secret);
		overlap = Math.max(overlap, secret.length - 1);
	}

	let pending = "";
	let pendingMasks = new Uint8Array(0);
	let maskedRegion = false;
	let state: "open" | "processing" | "finished" | "failed" = "open";

	function fail(): never {
		state = "failed";
		pending = "";
		pendingMasks = new Uint8Array(0);
		throw new Error(FAILURE_MESSAGE);
	}

	function consume(chunk: string, final: boolean): string {
		try {
			if (state !== "open" || typeof chunk !== "string") return fail();
			state = "processing";
			const raw = pending + chunk;
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
