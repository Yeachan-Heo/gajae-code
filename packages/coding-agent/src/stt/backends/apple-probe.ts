/**
 * Sacrificial safety probe for in-process Speech APIs.
 *
 * macOS TCC ABORTS the requesting process when the responsible app's
 * Info.plist lacks the matching usage description (observed live: SIGABRT
 * with "must contain an NSSpeechRecognitionUsageDescription key"), and
 * ancestry heuristics cannot *prove* which app TCC will hold responsible.
 * Instead of guessing, the probe exercises the exact crash surfaces —
 * speech authorization and a brief microphone/recognizer session — in a
 * child process. The child shares this process's TCC responsibility, so its
 * outcome mechanically predicts the in-process outcome:
 *
 * - child exits 0 with `{"ok":true}`        → in-process Speech is safe
 * - child dies from a signal (SIGABRT)      → in-process Speech would crash
 * - child reports a permission status        → surfaced as a typed reason
 *
 * The decision mapping is pure and unit-tested; only the spawn is impure.
 * Results are cached per process (TCC posture cannot change mid-process).
 */

import { logger } from "@gajae-code/utils";

export interface SpeechProbeOutcome {
	safe: boolean;
	/** Machine-readable reason when unsafe: `crash:<signal>` | `permission:<status>` | `error:<detail>`. */
	reason?: string;
}

export interface SpeechProbeExit {
	exitCode: number | null;
	signalCode: string | null;
	stdout: string;
}

/** Pure mapping from a probe child's exit facts to a safety outcome. */
export function decideProbeOutcome(exit: SpeechProbeExit): SpeechProbeOutcome {
	if (exit.signalCode) {
		// TCC kills the offending process — the signal IS the evidence.
		return { safe: false, reason: `crash:${exit.signalCode}` };
	}
	const line = exit.stdout.trim().split("\n").pop() ?? "";
	try {
		const parsed = JSON.parse(line) as { ok?: boolean; reason?: string };
		if (parsed.ok === true) return { safe: true };
		return { safe: false, reason: parsed.reason ?? `error:exit_${exit.exitCode}` };
	} catch {
		return { safe: false, reason: `error:unparseable_exit_${exit.exitCode}` };
	}
}

/**
 * Child program. Exercises, in order:
 * 1. speech authorization (prompts once when undetermined — the prompt is
 *    required for a real session anyway),
 * 2. a ~250ms recognizer session (microphone TCC surface), then cancels.
 * Communicates one JSON line on stdout.
 */
const PROBE_SOURCE = `
const nativesPath = process.env.GJC_SPEECH_PROBE_NATIVES;
const natives = await import(nativesPath);
const { MacSpeechSession, macSpeechAuthorizationStatus, macSpeechRequestAuthorization } = natives;
let status = macSpeechAuthorizationStatus() ?? "notDetermined";
if (status === "notDetermined") {
	status = await new Promise(resolve => {
		macSpeechRequestAuthorization((_err, s) => resolve(s));
		setTimeout(() => resolve("notDetermined"), 5 * 60 * 1000);
	});
}
if (status !== "authorized") {
	console.log(JSON.stringify({ ok: false, reason: "permission:" + status }));
	process.exit(20);
}
const session = MacSpeechSession.start({ onDeviceOnly: true, punctuation: false }, () => {});
await new Promise(resolve => setTimeout(resolve, 250));
session.cancel();
console.log(JSON.stringify({ ok: true }));
process.exit(0);
`;

/** Overall probe deadline — dominated by the one-time permission prompt. */
const PROBE_TIMEOUT_MS = 6 * 60 * 1000;

let cachedOutcome: SpeechProbeOutcome | null = null;

/** Test hook — reset the per-process probe cache. */
export function resetSpeechProbeCache(): void {
	cachedOutcome = null;
}

/**
 * Run the sacrificial probe (cached per process). Never throws — failures
 * degrade to `{ safe: false }` with a reason.
 */
export async function probeInProcessSpeechSafety(): Promise<SpeechProbeOutcome> {
	if (cachedOutcome) return cachedOutcome;
	if (process.platform !== "darwin") {
		cachedOutcome = { safe: false, reason: "error:not_darwin" };
		return cachedOutcome;
	}
	try {
		const nativesPath = require.resolve("@gajae-code/natives");
		const proc = Bun.spawn([process.execPath, "-e", PROBE_SOURCE], {
			env: { ...process.env, GJC_SPEECH_PROBE_NATIVES: nativesPath },
			stdout: "pipe",
			stderr: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
		const exitCode = await proc.exited;
		clearTimeout(timer);
		const stdout = await new Response(proc.stdout).text();
		const outcome = decideProbeOutcome({ exitCode, signalCode: proc.signalCode ?? null, stdout });
		if (!outcome.safe) {
			logger.warn("In-process speech probe reported unsafe", { reason: outcome.reason });
		}
		cachedOutcome = outcome;
	} catch (err) {
		logger.warn("In-process speech probe failed to run", { error: String(err) });
		cachedOutcome = { safe: false, reason: "error:spawn_failed" };
	}
	return cachedOutcome;
}
