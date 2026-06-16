/**
 * Opt-in renderer/runtime observability counters for the TUI.
 *
 * This module is the Stage 1 "observability foundation" surface. It is OFF by
 * default and only collects data when explicitly enabled, either via the
 * `PI_TUI_METRICS` environment flag or programmatically (used by the replay
 * harness and tests). When disabled, every record call is a single boolean
 * check at the call site, so default runtime overhead is negligible and no
 * existing render behavior changes.
 *
 * It tracks:
 *  - `#doRender` durations (p50/p95/p99/max/mean) — frame-time histogram.
 *  - `requestRender` source attribution — which callers ask for renders.
 *  - Full-redraw cause classification — why a frame fell back to full repaint.
 *  - Repaint-storm detection — runs of consecutive unexpected full redraws.
 *  - RSS samples — baseline/peak/last for memory-growth gates.
 *  - Owner/timer gauges — long-lived resource counts for leak gates.
 */
import { performance } from "node:perf_hooks";
import { $flag } from "@gajae-code/utils";

/** Number of consecutive unexpected full redraws that constitute a "storm". */
export const REPAINT_STORM_THRESHOLD = 3;

/** Hard cap on retained render-duration samples to keep memory bounded. */
const MAX_DURATION_SAMPLES = 200_000;

/** Hard cap on retained metric label keys; overflow is aggregated under `other`. */
export const MAX_LABEL_MAP_ENTRIES = 128;

const LABEL_OVERFLOW_KEY = "other";

/**
 * Normalize full-redraw causes before retaining them as metric labels. Some
 * render paths include dimensions in debug-facing reason strings; metrics keep
 * the stable cause class so resize/delete storms cannot create unbounded label
 * cardinality.
 */
function normalizeFullRedrawCause(cause: string): string {
	const c = cause.toLowerCase();
	if (c.startsWith("first render")) return "first render";
	if (c.startsWith("terminal width changed")) return "terminal width changed";
	if (c.startsWith("terminal height changed")) return "terminal height changed";
	if (c.startsWith("clearonshrink")) return "clearOnShrink";
	if (c.startsWith("extralines > height")) return "extraLines > height";
	if (c.startsWith("firstchanged < viewporttop")) return "firstChanged < viewportTop";
	return cause;
}

/**
 * Full-redraw causes that are expected and do not count toward repaint storms.
 * These are legitimate, unavoidable full repaints (first frame, resize, shrink
 * clearing). Steady-stream storms come from any other repeated full redraw.
 */
function isExpectedFullRedraw(cause: string): boolean {
	const c = cause.toLowerCase();
	return (
		c.startsWith("first render") ||
		c.includes("width changed") ||
		c.includes("height changed") ||
		c.startsWith("clearonshrink") ||
		c.includes("forced") ||
		c.includes("force")
	);
}

function retainedLabel<T>(map: Map<string, T>, label: string): string {
	if (map.has(label) || label === LABEL_OVERFLOW_KEY) return label;
	return map.size < MAX_LABEL_MAP_ENTRIES - 1 ? label : LABEL_OVERFLOW_KEY;
}

function incrementCount(map: Map<string, number>, label: string): void {
	const retained = retainedLabel(map, label);
	map.set(retained, (map.get(retained) ?? 0) + 1);
}

export interface DurationStats {
	count: number;
	meanMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
}

export interface RssStats {
	samples: number;
	baselineBytes: number | null;
	lastBytes: number | null;
	peakBytes: number;
	growthBytes: number;
	/** RSS sampled after the run + a forced GC (informational). */
	returnBytes: number | null;
	/** Heap used at baseline and after the run + forced GC (reclaimable signal). */
	heapBaselineBytes: number | null;
	heapReturnBytes: number | null;
	/** (heapReturn - heapBaseline) / heapBaseline; <= tolerance means heap returned. */
	returnWithinBaselineFraction: number | null;
}

export interface HelperStat {
	count: number;
	totalMs: number;
	meanMs: number;
}

export interface LineCountGauge {
	last: number;
	max: number;
}

export interface RenderMetricsSnapshot {
	enabled: boolean;
	renderCount: number;
	renderDurations: DurationStats;
	durationsTruncated: boolean;
	requestSources: Record<string, number>;
	fullRedrawCount: number;
	fullRedrawCauses: Record<string, number>;
	repaintStorms: number;
	maxConsecutiveFullRedraws: number;
	rss: RssStats;
	ownerGauges: Record<string, number>;
	timerGauges: Record<string, number>;
	helperStats: Record<string, HelperStat>;
	lineCounts: Record<string, LineCountGauge>;
}

function emptyDurationStats(): DurationStats {
	return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	if (lo === hi) return sorted[lo];
	const frac = rank - lo;
	return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

export class RenderMetrics {
	#enabled: boolean;
	#renderCount = 0;
	#durations: number[] = [];
	#durationsTruncated = false;
	#requestSources = new Map<string, number>();
	#fullRedrawCount = 0;
	#fullRedrawCauses = new Map<string, number>();
	#pendingUnexpectedFullRedraw = false;
	#consecutiveFullRedraws = 0;
	#maxConsecutiveFullRedraws = 0;
	#repaintStorms = 0;
	#rssSamples = 0;
	#rssBaseline: number | null = null;
	#rssLast: number | null = null;
	#rssPeak = 0;
	#ownerGauges = new Map<string, number>();
	#timerGauges = new Map<string, number>();
	#helpers = new Map<string, { count: number; totalMs: number }>();
	#lineGauges = new Map<string, LineCountGauge>();
	#rssReturn: number | null = null;
	#heapBaseline: number | null = null;
	#heapReturn: number | null = null;

	constructor(enabled = $flag("PI_TUI_METRICS")) {
		this.#enabled = enabled;
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	enable(): void {
		this.#enabled = true;
	}

	disable(): void {
		this.#enabled = false;
	}

	/** Reset all collected data (keeps the enabled state). */
	reset(): void {
		this.#renderCount = 0;
		this.#durations = [];
		this.#durationsTruncated = false;
		this.#requestSources.clear();
		this.#fullRedrawCount = 0;
		this.#fullRedrawCauses.clear();
		this.#pendingUnexpectedFullRedraw = false;
		this.#consecutiveFullRedraws = 0;
		this.#maxConsecutiveFullRedraws = 0;
		this.#repaintStorms = 0;
		this.#rssSamples = 0;
		this.#rssBaseline = null;
		this.#rssLast = null;
		this.#rssPeak = 0;
		this.#ownerGauges.clear();
		this.#timerGauges.clear();
		this.#helpers.clear();
		this.#lineGauges.clear();
		this.#rssReturn = null;
		this.#heapBaseline = null;
		this.#heapReturn = null;
	}

	/** High-resolution clock for timing render passes. Returns 0 when disabled. */
	now(): number {
		return this.#enabled ? performance.now() : 0;
	}

	/** Record that a render was requested, attributed to a caller source. */
	recordRequest(source = "unknown"): void {
		if (!this.#enabled) return;
		incrementCount(this.#requestSources, source);
	}

	/** Record one completed `#doRender` pass duration (ms). */
	recordRender(durationMs: number): void {
		if (!this.#enabled) return;
		this.#renderCount += 1;
		if (this.#durations.length < MAX_DURATION_SAMPLES) {
			this.#durations.push(durationMs);
		} else {
			this.#durationsTruncated = true;
		}

		// Storm bookkeeping: a render that performed an unexpected full redraw
		// extends the current run; any other render breaks it.
		if (this.#pendingUnexpectedFullRedraw) {
			this.#consecutiveFullRedraws += 1;
			if (this.#consecutiveFullRedraws > this.#maxConsecutiveFullRedraws) {
				this.#maxConsecutiveFullRedraws = this.#consecutiveFullRedraws;
			}
			if (this.#consecutiveFullRedraws === REPAINT_STORM_THRESHOLD) {
				this.#repaintStorms += 1;
			}
		} else {
			this.#consecutiveFullRedraws = 0;
		}
		this.#pendingUnexpectedFullRedraw = false;
	}

	/** Record a full-redraw event and classify its cause for storm detection. */
	recordFullRedraw(cause: string): void {
		if (!this.#enabled) return;
		this.#fullRedrawCount += 1;
		const normalizedCause = normalizeFullRedrawCause(cause);
		incrementCount(this.#fullRedrawCauses, normalizedCause);
		if (!isExpectedFullRedraw(normalizedCause)) {
			this.#pendingUnexpectedFullRedraw = true;
		}
	}

	/** Sample current RSS. Records baseline on first sample, tracks peak/last. */
	sampleRss(): number {
		if (!this.#enabled) return 0;
		const mem = process.memoryUsage();
		const rss = mem.rss;
		this.#rssSamples += 1;
		if (this.#rssBaseline === null) this.#rssBaseline = rss;
		if (this.#heapBaseline === null) this.#heapBaseline = mem.heapUsed;
		this.#rssLast = rss;
		if (rss > this.#rssPeak) this.#rssPeak = rss;
		return rss;
	}

	setOwnerGauge(name: string, value: number): void {
		if (!this.#enabled) return;
		this.#ownerGauges.set(name, value);
	}

	setTimerGauge(name: string, value: number): void {
		if (!this.#enabled) return;
		this.#timerGauges.set(name, value);
	}

	/** Accumulate timing/count for a named render helper (e.g. "renderTree"). */
	recordHelper(name: string, durationMs: number): void {
		if (!this.#enabled) return;
		const retained = retainedLabel(this.#helpers, name);
		const cur = this.#helpers.get(retained) ?? { count: 0, totalMs: 0 };
		cur.count += 1;
		cur.totalMs += durationMs;
		this.#helpers.set(retained, cur);
	}

	/** Record a per-render line-count gauge (e.g. "rendered", "normalized", "diffed"). */
	recordLineCount(name: string, value: number): void {
		if (!this.#enabled) return;
		const retained = retainedLabel(this.#lineGauges, name);
		const cur = this.#lineGauges.get(retained) ?? { last: 0, max: 0 };
		cur.last = value;
		if (value > cur.max) cur.max = value;
		this.#lineGauges.set(retained, cur);
	}

	/**
	 * Force a GC when the runtime exposes one and sample RSS as the post-run
	 * "return" value used by the memory-leak gate. Callers should drop large
	 * references before calling so reclaimable memory is actually freed.
	 */
	sampleReturn(): number {
		if (!this.#enabled) return 0;
		const bunGc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc;
		const nodeGc = (globalThis as { gc?: () => void }).gc;
		if (typeof bunGc === "function") bunGc(true);
		else if (typeof nodeGc === "function") nodeGc();
		const mem = process.memoryUsage();
		this.#rssReturn = mem.rss;
		this.#heapReturn = mem.heapUsed;
		if (this.#rssBaseline === null) this.#rssBaseline = mem.rss;
		if (this.#heapBaseline === null) this.#heapBaseline = mem.heapUsed;
		return mem.rss;
	}

	#durationStats(): DurationStats {
		if (this.#durations.length === 0) return emptyDurationStats();
		const sorted = [...this.#durations].sort((a, b) => a - b);
		const sum = sorted.reduce((acc, v) => acc + v, 0);
		return {
			count: sorted.length,
			meanMs: sum / sorted.length,
			p50Ms: percentile(sorted, 50),
			p95Ms: percentile(sorted, 95),
			p99Ms: percentile(sorted, 99),
			maxMs: sorted[sorted.length - 1],
		};
	}

	#helperStats(): Record<string, HelperStat> {
		const out: Record<string, HelperStat> = {};
		for (const [name, v] of this.#helpers) {
			out[name] = { count: v.count, totalMs: v.totalMs, meanMs: v.count ? v.totalMs / v.count : 0 };
		}
		return out;
	}

	#lineCountStats(): Record<string, LineCountGauge> {
		const out: Record<string, LineCountGauge> = {};
		for (const [name, v] of this.#lineGauges) {
			out[name] = { last: v.last, max: v.max };
		}
		return out;
	}

	snapshot(): RenderMetricsSnapshot {
		return {
			enabled: this.#enabled,
			renderCount: this.#renderCount,
			renderDurations: this.#durationStats(),
			durationsTruncated: this.#durationsTruncated,
			requestSources: Object.fromEntries(this.#requestSources),
			fullRedrawCount: this.#fullRedrawCount,
			fullRedrawCauses: Object.fromEntries(this.#fullRedrawCauses),
			repaintStorms: this.#repaintStorms,
			maxConsecutiveFullRedraws: this.#maxConsecutiveFullRedraws,
			rss: {
				samples: this.#rssSamples,
				baselineBytes: this.#rssBaseline,
				lastBytes: this.#rssLast,
				peakBytes: this.#rssPeak,
				growthBytes: this.#rssBaseline === null ? 0 : this.#rssPeak - this.#rssBaseline,
				returnBytes: this.#rssReturn,
				heapBaselineBytes: this.#heapBaseline,
				heapReturnBytes: this.#heapReturn,
				returnWithinBaselineFraction:
					this.#heapBaseline && this.#heapReturn !== null
						? (this.#heapReturn - this.#heapBaseline) / this.#heapBaseline
						: null,
			},
			ownerGauges: Object.fromEntries(this.#ownerGauges),
			timerGauges: Object.fromEntries(this.#timerGauges),
			helperStats: this.#helperStats(),
			lineCounts: this.#lineCountStats(),
		};
	}
}

/** Shared metrics instance used by the TUI render loop. */
export const renderMetrics = new RenderMetrics();
