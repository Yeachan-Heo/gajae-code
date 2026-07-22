/**
 * Bridge from TypeScript to the vendored insane-search Python engine.
 *
 * Invokes `python3 -m engine "<url>" --json` per fallback attempt (cwd + PYTHONPATH
 * pointed at the vendored engine), validates the JSON envelope, and maps it onto a
 * discriminated result. Hardened: clamped timeout, AbortSignal propagation that
 * kills+reaps the child, bounded stdout/stderr capture, and a per-process
 * concurrency cap so blocked reads cannot fork-storm.
 *
 * Fail-closed: missing dependencies / bad output / auth-required never throw past
 * the caller and never auto-install anything; they return ok:false with a stable,
 * bounded note so `read` can continue with its normal degraded result.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { $which } from "@gajae-code/utils";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/coding-agent/vendor/insane-search */
export const INSANE_VENDOR_DIR = path.resolve(HERE, "../../../vendor/insane-search");
const TEMPLATES_DIR = path.join(INSANE_VENDOR_DIR, "engine", "templates");

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_CONCURRENCY = 2;
const KILL_GRACE_MS = 2_000;

/** Stable note prefixes — tests assert on these without depending on full stderr. */
export const INSANE_NOTES = {
	securityDisabled: `insane fallback disabled: remote renderer cannot preserve validated network routing`,
	guardBlocked: (reason: string) => `insane fallback blocked: target URL is not public HTTP(S): ${reason}`,
	vendorMissing: `insane fallback unavailable: vendor engine missing at packages/coding-agent/vendor/insane-search`,
	noPython: `insane fallback unavailable: python3 not found; install python3 and curl_cffi, then retry with web.insaneFallback=true`,
	noCurlCffi: `insane fallback unavailable: python3 cannot import curl_cffi; install curl_cffi for Phase 0-2`,
	noBrowser: `insane fallback unavailable: node/playwright/stealth dependencies missing for Phase 3; install dependencies under packages/coding-agent/vendor/insane-search/engine/templates`,
	timeout: (seconds: number) => `insane fallback timed out after ${seconds}s; normal read fallback preserved`,
	invalidJson: `insane fallback failed: engine returned invalid JSON`,
	authRequired: `insane fallback stopped: authentication required`,
	verdict: (verdict: string) => `insane fallback failed: engine returned verdict=${verdict}`,
	untried: (routes: string) => `insane fallback routes not tried: ${routes}`,
	mustBrowserMcp: `insane fallback requires browser MCP/manual phase: must_invoke_playwright_mcp=true`,
	concurrency: `insane fallback skipped: max concurrent engine attempts reached`,
	emptyContent: `insane fallback failed: engine reported ok but returned no content`,
} as const;

/** Raw JSON envelope produced by `python3 -m engine --json`. */
export interface InsaneFetchResultRaw {
	ok?: boolean;
	verdict?: string;
	content?: string;
	profile_used?: string;
	trace?: unknown;
	untried_routes?: string[];
	must_invoke_playwright_mcp?: boolean;
}

export interface InsaneSuccess {
	ok: true;
	content: string;
	profileUsed?: string;
	notes: string[];
}

export interface InsaneFailure {
	ok: false;
	reason: string;
	verdict?: string;
	notes: string[];
}

export type InsaneBridgeResult = InsaneSuccess | InsaneFailure;

export interface EngineInvocation {
	url: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface EngineRawOutput {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

/** Seam: run the engine subprocess. Default spawns python3. */
export type EngineRunner = (inv: EngineInvocation) => Promise<EngineRawOutput>;

export interface InsaneDependencyStatus {
	vendorPresent: boolean;
	python: boolean;
	curlCffi: boolean;
	browser: boolean;
}

/** Seam: probe dependencies. Default probes the real environment (cached). */
export type DependencyProber = () => Promise<InsaneDependencyStatus>;

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

type SpawnImpl = typeof nodeSpawn;

function clampTimeoutMs(timeoutMs: number | undefined): number {
	const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
	return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

function appendCapped(buffer: string, chunk: string, cap: number): string {
	if (buffer.length >= cap) return buffer;
	const remaining = cap - buffer.length;
	return buffer + (chunk.length > remaining ? chunk.slice(0, remaining) : chunk);
}

/** Kill a child and its group, escalating to SIGKILL after a grace period. */
function killChild(child: ChildProcess): void {
	try {
		child.kill("SIGTERM");
	} catch {
		// already gone
	}
	const timer = setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}, KILL_GRACE_MS);
	timer.unref?.();
	child.once("exit", () => clearTimeout(timer));
}

/** Real engine runner: `python3 -m engine "<url>" --json`. */
export function runEngineSubprocess(
	inv: EngineInvocation,
	options: { spawnImpl?: SpawnImpl } = {},
): Promise<EngineRawOutput> {
	const spawnImpl = options.spawnImpl ?? nodeSpawn;
	return new Promise<EngineRawOutput>(resolve => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let aborted = false;

		const child = spawnImpl("python3", ["-m", "engine", inv.url, "--json"], {
			cwd: INSANE_VENDOR_DIR,
			env: { ...process.env, PYTHONPATH: INSANE_VENDOR_DIR },
			stdio: ["ignore", "pipe", "pipe"],
		});

		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			inv.signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, timedOut, aborted });
		};

		const timer = setTimeout(() => {
			timedOut = true;
			killChild(child);
		}, inv.timeoutMs);
		timer.unref?.();

		const onAbort = (): void => {
			aborted = true;
			killChild(child);
		};
		if (inv.signal) {
			if (inv.signal.aborted) onAbort();
			else inv.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = appendCapped(stdout, chunk.toString("utf8"), MAX_STDOUT_BYTES);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendCapped(stderr, chunk.toString("utf8"), MAX_STDERR_BYTES);
		});
		child.on("error", () => finish(null));
		child.on("close", code => finish(code));
	});
}

// ---------------------------------------------------------------------------
// Dependency probes (cached)
// ---------------------------------------------------------------------------

let probeCache: Promise<InsaneDependencyStatus> | null = null;

/** Reset the probe cache between tests so probe state never leaks. */
export function resetInsaneProbeCacheForTest(): void {
	probeCache = null;
}

function runProbeCommand(cmd: string, args: string[], cwd?: string): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		let settled = false;
		const done = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(ok);
		};
		const child = nodeSpawn(cmd, args, { cwd, stdio: "ignore" });
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// gone
			}
			done(false);
		}, 10_000);
		timer.unref?.();
		child.on("error", () => done(false));
		child.on("close", code => done(code === 0));
	});
}

async function probeRealDependencies(): Promise<InsaneDependencyStatus> {
	const { existsSync } = await import("node:fs");
	const vendorPresent = existsSync(path.join(INSANE_VENDOR_DIR, "engine", "__main__.py"));
	if (!vendorPresent) {
		return { vendorPresent: false, python: false, curlCffi: false, browser: false };
	}
	const python = Boolean($which("python3"));
	const curlCffi = python ? await runProbeCommand("python3", ["-c", "import curl_cffi"]) : false;
	const node = Boolean($which("node"));
	const browser = node
		? await runProbeCommand(
				"node",
				[
					"-e",
					"require.resolve('playwright');require.resolve('playwright-extra');require.resolve('puppeteer-extra-plugin-stealth')",
				],
				TEMPLATES_DIR,
			)
		: false;
	return { vendorPresent, python, curlCffi, browser };
}

/** Probe (and cache) the insane-search runtime dependencies. */
export function probeInsaneDependencies(): Promise<InsaneDependencyStatus> {
	if (!probeCache) probeCache = probeRealDependencies();
	return probeCache;
}

// ---------------------------------------------------------------------------
// Concurrency gate
// ---------------------------------------------------------------------------

let inFlight = 0;

export function resetInsaneConcurrencyForTest(): void {
	inFlight = 0;
}

// ---------------------------------------------------------------------------
// High-level bridge
// ---------------------------------------------------------------------------

export interface TryInsaneFetchOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	concurrencyLimit?: number;
	/** Seam: dependency prober (default real, cached). */
	prober?: DependencyProber;
	/** Seam: engine runner (default real subprocess). */
	runner?: EngineRunner;
}

function mapEngineOutput(raw: EngineRawOutput, timeoutMs: number): InsaneBridgeResult {
	const notes: string[] = [];
	if (raw.aborted) {
		return { ok: false, reason: "aborted", notes };
	}
	if (raw.timedOut) {
		notes.push(INSANE_NOTES.timeout(Math.round(timeoutMs / 1000)));
		return { ok: false, reason: "timeout", notes };
	}
	let parsed: InsaneFetchResultRaw;
	try {
		parsed = JSON.parse(raw.stdout) as InsaneFetchResultRaw;
	} catch {
		notes.push(INSANE_NOTES.invalidJson);
		return { ok: false, reason: "invalid-json", notes };
	}

	const verdict = parsed.verdict?.trim();
	// The engine emits the Verdict enum value `auth_required` (401/407); also tolerate
	// the human-readable phrase defensively. Either is a terminal public-content boundary.
	if (verdict && /^(?:auth_required|authentication required)$/i.test(verdict)) {
		notes.push(INSANE_NOTES.authRequired);
		return { ok: false, reason: "auth-required", verdict, notes };
	}

	if (parsed.untried_routes && parsed.untried_routes.length > 0) {
		notes.push(INSANE_NOTES.untried(parsed.untried_routes.slice(0, 8).join(", ")));
	}
	if (parsed.must_invoke_playwright_mcp) {
		notes.push(INSANE_NOTES.mustBrowserMcp);
	}

	if (parsed.ok && typeof parsed.content === "string" && parsed.content.trim().length > 0) {
		return { ok: true, content: parsed.content, profileUsed: parsed.profile_used, notes };
	}
	if (parsed.ok) {
		notes.push(INSANE_NOTES.emptyContent);
		return { ok: false, reason: "empty-content", notes };
	}
	notes.push(INSANE_NOTES.verdict(verdict || "unknown"));
	return { ok: false, reason: "engine-failed", verdict, notes };
}

/**
 * Attempt to read `url` through the insane-search engine. The caller is
 * responsible for the opt-in gate, raw-mode skip, and the public-URL guard
 * (which MUST run before this is called). Never throws; always returns a result.
 */
export async function tryInsaneFetch(url: string, options: TryInsaneFetchOptions = {}): Promise<InsaneBridgeResult> {
	if (!options.runner) {
		return { ok: false, reason: "disabled-security", notes: [INSANE_NOTES.securityDisabled] };
	}
	const prober = options.prober ?? probeInsaneDependencies;
	const runner = options.runner;
	const limit = options.concurrencyLimit ?? DEFAULT_CONCURRENCY;

	const deps = await prober();
	if (!deps.vendorPresent) return { ok: false, reason: "vendor-missing", notes: [INSANE_NOTES.vendorMissing] };
	if (!deps.python) return { ok: false, reason: "no-python", notes: [INSANE_NOTES.noPython] };
	if (!deps.curlCffi) return { ok: false, reason: "no-curl-cffi", notes: [INSANE_NOTES.noCurlCffi] };
	if (!deps.browser) return { ok: false, reason: "no-browser", notes: [INSANE_NOTES.noBrowser] };

	if (inFlight >= limit) {
		return { ok: false, reason: "concurrency", notes: [INSANE_NOTES.concurrency] };
	}

	inFlight++;
	try {
		const timeoutMs = clampTimeoutMs(options.timeoutMs);
		const raw = await runner({ url, timeoutMs, signal: options.signal });
		return mapEngineOutput(raw, timeoutMs);
	} finally {
		inFlight--;
	}
}
