/**
 * Detects a running command that printed an interactive auth prompt and is now
 * waiting for a human (browser sign-in URL or device code).
 *
 * The agent cannot see this on its own: the tool call is simply still running.
 * The detector watches the streamed output tail and fires once per command when
 * all of these hold:
 *   - a known auth-prompt signature is present in the recent output tail;
 *   - the command is still running (the caller stops feeding it on exit);
 *   - no new output arrived for `quietMs` after the match.
 *
 * Requiring the quiet window keeps `cat README.md` or `grep` over docs that
 * merely mention "enter the code" from firing: those commands exit or keep
 * printing. The signal carries only the prompt kind, never the URL or code,
 * because both are short-lived credential-equivalent values.
 */
import { stripVTControlCharacters } from "node:util";

export type AwaitingInputKind = "browser_auth" | "device_code";

export interface AwaitingInputSignal {
	kind: AwaitingInputKind;
	/** Epoch milliseconds when the quiet window elapsed after the match. */
	detectedAt: number;
}

/** Cancels a scheduled callback. */
export type CancelScheduled = () => void;

export interface AwaitingInputDetectorOptions {
	onDetect: (signal: AwaitingInputSignal) => void;
	/** Quiet window after a match before the signal fires. */
	quietMs?: number;
	/** Injectable scheduler; defaults to `setTimeout`. */
	schedule?: (callback: () => void, ms: number) => CancelScheduled;
	/** Injectable clock; defaults to `Date.now`. */
	now?: () => number;
}

export const AWAITING_INPUT_QUIET_MS = 3_000;

/** Only the most recent output can be the prompt the process is blocked on. */
const TAIL_CHARS = 2_048;

const URL_PATTERN = /\bhttps?:\/\/\S+/i;

const DEVICE_CODE_PATTERNS: readonly RegExp[] = [
	/\bone-time code\b/i,
	/\benter the code\b/i,
	/\benter code\b/i,
	/\buser_code=/i,
];

const BROWSER_AUTH_PATTERNS: readonly RegExp[] = [
	/\bto authenticate,? visit\b/i,
	/\blogin\.tailscale\.com\/a\//i,
	/\bgo to the following link in your browser\b/i,
	/\bopen the following url\b/i,
	/\bvisit this url to authori[sz]e\b/i,
	/\bopen (?:this|the) (?:url|link) in (?:a|your) browser\b/i,
];

/** Classify an output tail; `undefined` when it does not look like an auth prompt. */
export function classifyAwaitingInput(tail: string): AwaitingInputKind | undefined {
	const text = stripVTControlCharacters(tail);
	if (DEVICE_CODE_PATTERNS.some(pattern => pattern.test(text))) return "device_code";
	if (URL_PATTERN.test(text) && BROWSER_AUTH_PATTERNS.some(pattern => pattern.test(text))) return "browser_auth";
	return undefined;
}

function defaultSchedule(callback: () => void, ms: number): CancelScheduled {
	const timer = setTimeout(callback, ms);
	return () => clearTimeout(timer);
}

export class AwaitingInputDetector {
	readonly #onDetect: (signal: AwaitingInputSignal) => void;
	readonly #quietMs: number;
	readonly #schedule: (callback: () => void, ms: number) => CancelScheduled;
	readonly #now: () => number;
	#tail = "";
	#cancel: CancelScheduled | undefined;
	#done = false;

	constructor(options: AwaitingInputDetectorOptions) {
		this.#onDetect = options.onDetect;
		this.#quietMs = options.quietMs ?? AWAITING_INPUT_QUIET_MS;
		this.#schedule = options.schedule ?? defaultSchedule;
		this.#now = options.now ?? Date.now;
	}

	/** Feed one streamed output chunk. Any new output restarts the quiet window. */
	push(chunk: string): void {
		if (this.#done || chunk.length === 0) return;
		this.#cancel?.();
		this.#cancel = undefined;
		this.#tail = (this.#tail + chunk).slice(-TAIL_CHARS);
		const kind = classifyAwaitingInput(this.#tail);
		if (!kind) return;
		this.#cancel = this.#schedule(() => {
			this.#cancel = undefined;
			if (this.#done) return;
			this.#done = true;
			this.#onDetect({ kind, detectedAt: this.#now() });
		}, this.#quietMs);
	}

	/** Stop watching; the command exited or was folded. Never fires afterwards. */
	dispose(): void {
		this.#done = true;
		this.#cancel?.();
		this.#cancel = undefined;
	}
}
