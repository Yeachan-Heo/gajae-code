/**
 * Autoresearch harness contract: the `autoresearch.sh` entrypoint contract plus
 * parsing of `METRIC <name>=<value>` and `ASI <key>=<value>` lines out of
 * captured output.
 *
 * The contract (ported from the deleted extension's `helpers.ts`):
 * - the harness is `./autoresearch.sh` at the working directory;
 * - it exits 0 on success and non-zero on failure;
 * - it prints the primary metric as `METRIC <name>=<value>` and any secondary
 *   metrics as additional `METRIC` lines;
 * - it may print `ASI <key>=<value>` lines for opaque structured learnings.
 *
 * Parsing tolerates interleaved noise: only well-formed lines are recognized,
 * malformed lines are ignored (never thrown), and prototype-polluting key
 * names are dropped.
 */
import type { ASIData, ASIValue, MetricDirection, NumericMetricMap } from "./types";

export const HARNESS_FILENAME = "autoresearch.sh";
export const DEFAULT_HARNESS_COMMAND = `bash ${HARNESS_FILENAME}`;

export const METRIC_LINE_PREFIX = "METRIC";
export const ASI_LINE_PREFIX = "ASI";
export const EXPERIMENT_MAX_LINES = 10;
export const EXPERIMENT_MAX_BYTES = 4 * 1024;

const DENIED_KEY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const METRIC_LINE_RE = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ-]+)=(\\S+)\\s*$`, "gm");
const ASI_LINE_RE = new RegExp(`^${ASI_LINE_PREFIX}\\s+([\\w.-]+)=(.+)\\s*$`, "gm");

/** All `METRIC name=value` lines found anywhere in the captured output. */
export function parseMetricLines(output: string): Map<string, number> {
	const metrics = new Map<string, number>();
	let match = METRIC_LINE_RE.exec(output);
	while (match !== null) {
		const name = match[1] ?? "";
		if (!DENIED_KEY_NAMES.has(name)) {
			const value = Number(match[2]);
			if (Number.isFinite(value)) {
				metrics.set(name, value);
			}
		}
		match = METRIC_LINE_RE.exec(output);
	}
	return metrics;
}

/** All `ASI key=value` lines found anywhere in the captured output, or null when none parse. */
export function parseAsiLines(output: string): ASIData | null {
	const asi: ASIData = {};
	let match = ASI_LINE_RE.exec(output);
	while (match !== null) {
		const key = match[1] ?? "";
		if (!DENIED_KEY_NAMES.has(key)) {
			asi[key] = parseAsiValue(match[2] ?? "");
		}
		match = ASI_LINE_RE.exec(output);
	}
	return Object.keys(asi).length > 0 ? asi : null;
}

function parseAsiValue(raw: string): ASIValue {
	const value = raw.trim();
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;
	if (/^-?\d+(?:\.\d+)?$/.test(value)) {
		const numberValue = Number(value);
		if (Number.isFinite(numberValue)) return numberValue;
	}
	if (value.startsWith("{") || value.startsWith("[") || value.startsWith('"')) {
		try {
			return JSON.parse(value) as ASIValue;
		} catch {
			return value;
		}
	}
	return value;
}

export interface ParsedHarnessOutput {
	/** Every parsed metric, keyed by name. */
	metrics: NumericMetricMap;
	/**
	 * The surfaced primary metric: `metrics[primaryMetricName]` when a name is
	 * supplied, otherwise the value of the first `METRIC` line in the output.
	 */
	primary: number | null;
	/** Parsed ASI learnings, or null when no ASI line parsed. */
	asi: ASIData | null;
}

/**
 * Parse captured harness output into the primary metric, secondary values, and
 * ASI learnings. Malformed or noisy lines are ignored, never thrown.
 */
export function parseHarnessOutput(output: string, primaryMetricName?: string): ParsedHarnessOutput {
	const metricMap = parseMetricLines(output);
	const metrics: NumericMetricMap = {};
	for (const [name, value] of metricMap.entries()) {
		metrics[name] = value;
	}
	let primary: number | null = null;
	if (primaryMetricName !== undefined) {
		primary = metricMap.get(primaryMetricName) ?? null;
	} else {
		const first = metricMap.entries().next();
		primary = first.done ? null : first.value[1];
	}
	return { metrics, primary, asi: parseAsiLines(output) };
}

export function mergeAsi(base: ASIData | null, override: ASIData | undefined): ASIData | undefined {
	if (!base && !override) return undefined;
	return {
		...(base ?? {}),
		...(override ?? {}),
	};
}

export function commas(value: number): string {
	const sign = value < 0 ? "-" : "";
	const digits = String(Math.trunc(Math.abs(value)));
	const groups: string[] = [];
	for (let index = digits.length; index > 0; index -= 3) {
		groups.unshift(digits.slice(Math.max(0, index - 3), index));
	}
	return sign + groups.join(",");
}

export function fmtNum(value: number, decimals: number = 0): string {
	if (decimals <= 0) return commas(Math.round(value));
	const absolute = Math.abs(value);
	const whole = Math.floor(absolute);
	const fraction = (absolute - whole).toFixed(decimals).slice(1);
	return `${value < 0 ? "-" : ""}${commas(whole)}${fraction}`;
}

export function formatNum(value: number | null, unit: string): string {
	if (value === null) return "-";
	if (Number.isInteger(value)) return `${fmtNum(value)}${unit}`;
	return `${fmtNum(value, 2)}${unit}`;
}

export function formatElapsed(milliseconds: number): string {
	const totalSeconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	return `${seconds}s`;
}

/** True when `current` beats `best` under the given direction. */
export function isBetter(current: number, best: number, direction: MetricDirection): boolean {
	return direction === "lower" ? current < best : current > best;
}

export function inferMetricUnitFromName(name: string): string {
	if (name.endsWith("µs") || name.endsWith("_µs")) return "µs";
	if (name.endsWith("ms") || name.endsWith("_ms")) return "ms";
	if (name.endsWith("_s") || name.endsWith("_sec") || name.endsWith("_secs")) return "s";
	if (name.endsWith("_kb") || name.endsWith("kb")) return "kb";
	if (name.endsWith("_mb") || name.endsWith("mb")) return "mb";
	return "";
}

export function normalizePathSpec(value: string): string {
	const trimmed = value.trim().replaceAll("\\", "/");
	if (trimmed === "" || trimmed === "." || trimmed === "./") return ".";
	const collapsed = trimmed.replace(/^\.\/+/, "").replace(/\/+$/, "");
	return collapsed.length === 0 ? "." : collapsed;
}

export function pathMatchesSpec(pathValue: string, specValue: string): boolean {
	const normalizedPath = normalizePathSpec(pathValue);
	const normalizedSpec = normalizePathSpec(specValue);
	if (normalizedSpec === ".") return true;
	return normalizedPath === normalizedSpec || normalizedPath.startsWith(`${normalizedSpec}/`);
}

export function dedupeStrings(values: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const trimmed = value.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

export function ensureNumericMetricMap(value: NumericMetricMap | undefined): NumericMetricMap {
	if (!value) return {};
	const out: NumericMetricMap = {};
	for (const [key, entryValue] of Object.entries(value)) {
		if (DENIED_KEY_NAMES.has(key)) continue;
		if (typeof entryValue === "number" && Number.isFinite(entryValue)) {
			out[key] = entryValue;
		}
	}
	return out;
}

export function sanitizeAsi(value: { [key: string]: unknown } | undefined): ASIData | undefined {
	if (!value) return undefined;
	const result: ASIData = {};
	for (const [key, entryValue] of Object.entries(value)) {
		if (DENIED_KEY_NAMES.has(key)) continue;
		const sanitized = sanitizeAsiValue(entryValue);
		if (sanitized !== undefined) {
			result[key] = sanitized;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeAsiValue(value: unknown): ASIValue | undefined {
	if (value === null) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		const items = value
			.map(item => sanitizeAsiValue(item))
			.filter((item): item is NonNullable<typeof item> => item !== undefined);
		return items;
	}
	if (typeof value === "object") {
		const objectValue = value as { [key: string]: unknown };
		const result: ASIData = {};
		for (const [key, entryValue] of Object.entries(objectValue)) {
			if (DENIED_KEY_NAMES.has(key)) continue;
			const sanitized = sanitizeAsiValue(entryValue);
			if (sanitized !== undefined) {
				result[key] = sanitized;
			}
		}
		return result;
	}
	return undefined;
}
