/**
 * Offline stealth-detector benchmark model.
 *
 * Pure, deterministic logic for the anti-detection benchmark suite: it converts
 * a browser-collected fingerprint probe into a normalized per-detector verdict,
 * implements the falsifiable CI gate (see plan Phase 1 / R-T3), and renders a
 * before/after report. No browser or network access lives here so it can be
 * unit-tested deterministically; the harness that drives the real browser tool
 * against vendored detector fixtures feeds its output into these functions.
 */

export type SignalStatus = "pass" | "fail";

/** A single boolean fingerprint signal, e.g. "navigator.webdriver is undefined". */
export interface DetectorSignal {
	/** Stable identifier, used to diff across runs. */
	id: string;
	/** Human-readable label for the report. */
	label: string;
	/** `pass` means the signal looks human; `fail` means it leaks automation. */
	status: SignalStatus;
	/** Optional observed value for debugging. */
	detail?: string;
}

export type AutomatedVerdict = "human" | "bot" | "unknown";

/** Normalized result for one detector (e.g. bot.sannysoft, CreepJS). */
export interface DetectorResult {
	detector: string;
	signals: DetectorSignal[];
	/** Overall automated/not classification when the detector exposes one. */
	automatedVerdict: AutomatedVerdict;
	/** Absolute trust score (observability-only, never a hard gate). */
	trustScore: number | null;
}

/** Shape emitted by the offline probe fixture on `window.__stealthProbe`. */
export interface RawProbe {
	detector: string;
	signals: Array<{ id: string; label: string; pass: boolean; detail?: string }>;
	automatedVerdict?: AutomatedVerdict;
	trustScore?: number | null;
}

/** Convert a raw browser-collected probe into a normalized {@link DetectorResult}. */
export function parseProbe(raw: RawProbe): DetectorResult {
	if (!raw || typeof raw.detector !== "string" || !Array.isArray(raw.signals)) {
		throw new Error("invalid stealth probe payload");
	}
	const signals: DetectorSignal[] = raw.signals.map(s => ({
		id: s.id,
		label: s.label,
		status: s.pass ? "pass" : "fail",
		...(s.detail !== undefined ? { detail: s.detail } : {}),
	}));
	return {
		detector: raw.detector,
		signals,
		automatedVerdict: raw.automatedVerdict ?? "unknown",
		trustScore: raw.trustScore ?? null,
	};
}

function passCount(result: DetectorResult): number {
	return result.signals.filter(s => s.status === "pass").length;
}

function failingSignalIds(result: DetectorResult): Set<string> {
	return new Set(result.signals.filter(s => s.status === "fail").map(s => s.id));
}

export interface GateOutcome {
	pass: boolean;
	reasons: string[];
}

/**
 * Falsifiable CI gate (plan Phase 1 / R-T3, R-C1, R-C2):
 *   (a) zero failing signals in the current run, AND
 *       current pass-count >= baseline pass-count (no silent regression), AND
 *   (b) either at least one signal that failed at baseline now passes,
 *       OR the baseline was already all-green (empty-gap regression lock).
 * The absolute `trustScore` is never consulted here; it is observability-only.
 */
export function evaluateGate(baseline: DetectorResult, current: DetectorResult): GateOutcome {
	const reasons: string[] = [];
	const currentFail = failingSignalIds(current);
	if (currentFail.size > 0) {
		reasons.push(
			`${current.detector}: ${currentFail.size} signal(s) still leak automation: ${[...currentFail].join(", ")}`,
		);
	}

	const baselinePass = passCount(baseline);
	const currentPass = passCount(current);
	if (currentPass < baselinePass) {
		reasons.push(`${current.detector}: pass-count regressed (${currentPass} < baseline ${baselinePass})`);
	}

	const baselineFail = failingSignalIds(baseline);
	const currentPassIds = new Set(current.signals.filter(s => s.status === "pass").map(s => s.id));
	const newlyPassing = [...baselineFail].filter(id => currentPassIds.has(id));
	const baselineAllGreen = baselineFail.size === 0;
	if (!baselineAllGreen && newlyPassing.length === 0) {
		reasons.push(`${current.detector}: no baseline-failing signal was fixed (improvement required)`);
	}

	return { pass: reasons.length === 0, reasons };
}

/** Aggregate gate across every detector; passes only when all detectors pass. */
export function evaluateSuiteGate(
	baseline: readonly DetectorResult[],
	current: readonly DetectorResult[],
): GateOutcome {
	const reasons: string[] = [];
	const currentByName = new Map(current.map(r => [r.detector, r]));
	for (const base of baseline) {
		const now = currentByName.get(base.detector);
		if (!now) {
			reasons.push(`${base.detector}: missing from current run`);
			continue;
		}
		reasons.push(...evaluateGate(base, now).reasons);
	}
	return { pass: reasons.length === 0, reasons };
}

/** Render a deterministic before/after markdown report for one run. */
export function renderReport(baseline: readonly DetectorResult[], current: readonly DetectorResult[]): string {
	const lines: string[] = ["# Stealth Benchmark Report", ""];
	const gate = evaluateSuiteGate(baseline, current);
	lines.push(`Gate: ${gate.pass ? "PASS" : "FAIL"}`, "");
	const currentByName = new Map(current.map(r => [r.detector, r]));
	for (const base of baseline) {
		const now = currentByName.get(base.detector);
		lines.push(`## ${base.detector}`);
		lines.push(
			`- Automated verdict: ${base.automatedVerdict} -> ${now?.automatedVerdict ?? "n/a"}`,
			`- Trust score (observability): ${base.trustScore ?? "n/a"} -> ${now?.trustScore ?? "n/a"}`,
			`- Passing signals: ${passCount(base)} -> ${now ? passCount(now) : "n/a"} of ${base.signals.length}`,
			"",
			"| Signal | Baseline | Current |",
			"|--------|----------|---------|",
		);
		for (const sig of base.signals) {
			const nowSig = now?.signals.find(s => s.id === sig.id);
			lines.push(`| ${sig.label} | ${sig.status} | ${nowSig?.status ?? "n/a"} |`);
		}
		lines.push("");
	}
	if (!gate.pass) {
		lines.push("## Blocking reasons", ...gate.reasons.map(r => `- ${r}`), "");
	}
	return lines.join("\n");
}
