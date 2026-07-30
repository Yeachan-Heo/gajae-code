#!/usr/bin/env bun
/**
 * Alibaba Token Plan header-parity latency A/B benchmark (issue #3557).
 *
 * Compares TWO header fingerprints against a deterministic local HTTP server:
 *   A — legacy/current mismatched headers (no DashScope identity headers)
 *   B — Qwen Code-identical headers (canonical DashScope Token Plan set)
 *
 * Everything else is held constant: same endpoint, model, prompt/body, process,
 * runtime, connection policy. A/B requests are INTERLEAVED with a fixed PRNG
 * seed to reduce temporal bias. Warm-up requests are excluded from the sample.
 *
 * This harness is validated against a LOCAL deterministic server only — it does
 * NOT call a real Alibaba endpoint. No live credentials are required or used.
 * The server emits a fixed-size SSE stream so TTFT/total latency reflects only
 * transport/header overhead, not model compute.
 *
 * Usage:
 *   bun --cwd=packages/ai scripts/alibaba-token-plan-latency-ab.ts [options]
 *
 * Options:
 *   --n <count>        Sample requests per arm (default 30)
 *   --warmup <count>   Warm-up requests per arm, excluded from stats (default 5)
 *   --port <port>      Local server port (default 0 = ephemeral)
 *   --seed <int>       PRNG seed for A/B interleaving order (default 42)
 *
 * Output: JSON stats (n, success/error/timeout, TTFT + total latency
 * median/p90/p95/mean/stddev) to stdout, plus a human summary on stderr.
 *
 * SECURITY: No tokens, prompts, or private response bodies are printed. The
 * harness uses a dummy API key ("benchmark-key") that never leaves the local
 * server. Authorization is present only by scheme on the wire.
 */
import { createServer, type Server } from "node:http";
import {
	dashscopeTokenPlanDefaultHeaders,
	QWEN_CODE_UPSTREAM_COMMIT,
	QWEN_CODE_UPSTREAM_VERSION,
} from "../src/providers/dashscope-token-plan-headers";

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { n: number; warmup: number; port: number; seed: number } {
	const opts = { n: 30, warmup: 5, port: 0, seed: 42 };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--n" && next !== undefined) opts.n = Number(next);
		else if (arg === "--warmup" && next !== undefined) opts.warmup = Number(next);
		else if (arg === "--port" && next !== undefined) opts.port = Number(next);
		else if (arg === "--seed" && next !== undefined) opts.seed = Number(next);
	}
	if (!(opts.n > 0) || !(opts.warmup >= 0) || !(opts.seed >= 0)) {
		throw new Error("Invalid CLI options");
	}
	return opts;
}

// ── Deterministic PRNG (mulberry32) for fixed-seed interleaving ─────────────

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ── Statistics ───────────────────────────────────────────────────────────────

interface Stats {
	n: number;
	median: number;
	p90: number;
	p95: number;
	mean: number;
	stddev: number;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, idx)];
}

function computeStats(values: number[]): Stats {
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	if (n === 0) return { n: 0, median: 0, p90: 0, p95: 0, mean: 0, stddev: 0 };
	const mean = sorted.reduce((sum, v) => sum + v, 0) / n;
	const variance = sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
	return {
		n,
		median: sorted[Math.floor(n / 2)],
		p90: percentile(sorted, 90),
		p95: percentile(sorted, 95),
		mean,
		stddev: Math.sqrt(variance),
	};
}

// ── Deterministic local HTTP server ──────────────────────────────────────────
// Emits a fixed-size SSE stream so latency reflects only transport/header
// overhead. Captures the incoming request headers (redacted) for verification.

interface ServerCapture {
	status: number;
	headers: Record<string, string>;
	bodyBytes: number;
}

function createDeterministicServer(): { server: Server; captures: ServerCapture[] } {
	const captures: ServerCapture[] = [];
	const server = createServer((req, res) => {
		// Capture request headers (lowercased) WITHOUT the Authorization value.
		const incomingHeaders: Record<string, string> = {};
		for (const [key, value] of Object.entries(req.headers)) {
			if (key.toLowerCase() === "authorization") {
				incomingHeaders[key.toLowerCase()] =
					typeof value === "string" && value.startsWith("Bearer ") ? "Bearer <redacted>" : "<redacted>";
			} else if (typeof value === "string") {
				incomingHeaders[key.toLowerCase()] = value;
			}
		}
		let bodyBytes = 0;
		req.on("data", chunk => {
			bodyBytes += chunk.length;
		});
		req.on("end", () => {
			captures.push({ status: 200, headers: incomingHeaders, bodyBytes });
			// Fixed-size SSE response: 5 chunks of identical content + DONE.
			const chunk = `data: ${JSON.stringify({ id: "ab", choices: [{ delta: { content: "x".repeat(64) }, finish_reason: null }] })}\n\n`;
			const frames = [
				chunk,
				chunk,
				chunk,
				chunk,
				chunk,
				`data: ${JSON.stringify({ id: "ab", choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
			];
			res.writeHead(200, { "content-type": "text/event-stream" });
			let i = 0;
			const send = () => {
				if (i < frames.length) {
					res.write(frames[i]);
					i++;
					// Deterministic inter-frame delay so TTFT is measurable but stable.
					setTimeout(send, 2);
				} else {
					res.end();
				}
			};
			send();
		});
	});
	return { server, captures };
}

// ── Single request (capture TTFT + total) ────────────────────────────────────

interface RequestResult {
	ttftMs: number | null;
	totalMs: number;
	ok: boolean;
	timedOut: boolean;
	error: string | null;
}

async function singleRequest(
	baseUrl: string,
	headers: Record<string, string>,
	arm: "A" | "B",
	timeoutMs: number,
): Promise<RequestResult> {
	const start = performance.now();
	let firstByteMs: number | null = null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				...headers,
				"content-type": "application/json",
				authorization: "Bearer benchmark-key",
				"x-benchmark-arm": arm,
			},
			body: JSON.stringify({
				model: "deepseek-v4-pro",
				messages: [{ role: "user", content: "bench" }],
				stream: true,
			}),
			signal: controller.signal,
		});
		if (!response.ok || !response.body) {
			clearTimeout(timer);
			return {
				ttftMs: null,
				totalMs: performance.now() - start,
				ok: false,
				timedOut: false,
				error: `HTTP ${response.status}`,
			};
		}
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (firstByteMs === null && value && value.length > 0) firstByteMs = performance.now();
			if (done) break;
		}
		clearTimeout(timer);
		return {
			ttftMs: firstByteMs !== null ? firstByteMs - start : null,
			totalMs: performance.now() - start,
			ok: true,
			timedOut: false,
			error: null,
		};
	} catch (err) {
		clearTimeout(timer);
		const timedOut = err instanceof DOMException && err.name === "AbortError";
		return {
			ttftMs: firstByteMs !== null ? firstByteMs - start : null,
			totalMs: performance.now() - start,
			ok: false,
			timedOut,
			error: timedOut ? "timeout" : (err as Error).message,
		};
	}
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const { n, warmup, port, seed } = parseArgs(process.argv.slice(2));
	const { server, captures } = createDeterministicServer();
	await new Promise<void>(resolve => server.listen(port, resolve));
	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : 0;
	const baseUrl = `http://127.0.0.1:${actualPort}`;

	// Arm A: legacy/missing DashScope identity headers.
	const legacyHeaders = { "User-Agent": "legacy-benchmark/1.0" };
	// Arm B: Qwen Code-identical canonical set.
	const qwenHeaders = { ...dashscopeTokenPlanDefaultHeaders() };

	// Fixed-seed interleaved order over (warmup + n) requests per arm.
	const rng = mulberry32(seed);
	const totalPerArm = warmup + n;
	const order: ("A" | "B")[] = [];
	for (let i = 0; i < totalPerArm; i++) {
		order.push("A");
		order.push("B");
	}
	// Fisher-Yates shuffle with the seeded RNG.
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
	}

	const armResults: Record<"A" | "B", RequestResult[]> = { A: [], B: [] };
	const timeoutMs = 10_000;
	let aIndex = 0;
	let bIndex = 0;

	for (const arm of order) {
		const result = await singleRequest(baseUrl, arm === "A" ? legacyHeaders : qwenHeaders, arm, timeoutMs);
		// Drop warmups from the stats sample.
		if (arm === "A") {
			if (aIndex >= warmup) armResults.A.push(result);
			aIndex++;
		} else {
			if (bIndex >= warmup) armResults.B.push(result);
			bIndex++;
		}
	}

	server.close();

	// ── Stats ─────────────────────────────────────────────────────────────────
	function summarize(arm: "A" | "B", label: string) {
		const results = armResults[arm];
		const success = results.filter(r => r.ok).length;
		const error = results.filter(r => !r.ok && !r.timedOut).length;
		const timedOut = results.filter(r => r.timedOut).length;
		const ttftValues = results.filter(r => r.ttftMs !== null).map(r => r.ttftMs!);
		const totalValues = results.map(r => r.totalMs);
		return {
			arm,
			label,
			n: results.length,
			success,
			error,
			timeout: timedOut,
			ttft: computeStats(ttftValues),
			total: computeStats(totalValues),
		};
	}

	const statsA = summarize("A", "legacy/current mismatched headers");
	const statsB = summarize("B", "Qwen Code-identical headers");

	// ── Wire verification (redacted, partitioned by arm marker) ───────────────
	// Exact per-capture: every B capture must carry ALL FOUR canonical values;
	// every A capture must lack ALL THREE DashScope-specific headers. A partial
	// fingerprint (e.g. only AuthType present in B, or AuthType alone leaked in
	// A) must NOT pass. This validates the complete arm fingerprint, not just
	// one marker header.
	const dashscopeKeys = ["x-dashscope-cachecontrol", "x-dashscope-useragent", "x-dashscope-authtype"] as const;
	const armACaptures = captures.filter(c => c.headers["x-benchmark-arm"] === "A");
	const armBCaptures = captures.filter(c => c.headers["x-benchmark-arm"] === "B");
	const expectedUa = `QwenCode/${QWEN_CODE_UPSTREAM_VERSION} (${process.platform}; ${process.arch})`;
	const everyBHasFullCanonical =
		armBCaptures.length > 0 &&
		armBCaptures.every(
			c =>
				c.headers["user-agent"] === expectedUa &&
				c.headers["x-dashscope-cachecontrol"] === "enable" &&
				c.headers["x-dashscope-useragent"] === expectedUa &&
				c.headers["x-dashscope-authtype"] === "openai",
		);
	const armAHasAnyDashscope = armACaptures.some(c => dashscopeKeys.some(key => c.headers[key] !== undefined));

	const report = {
		upstream: {
			repo: "QwenLM/qwen-code",
			commit: QWEN_CODE_UPSTREAM_COMMIT,
			version: QWEN_CODE_UPSTREAM_VERSION,
		},
		config: { n, warmup, seed, port: actualPort, timeoutMs, server: "local-deterministic" },
		arms: { A: statsA, B: statsB },
		wire: {
			armB_every_capture_full_canonical: everyBHasFullCanonical,
			armB_captures: armBCaptures.length,
			armA_every_capture_no_dashscope: !armAHasAnyDashscope,
			armA_captures: armACaptures.length,
			note: "Synthetic loopback smoke test (raw fetch, NOT production SDK shape). Exact per-capture: every B capture carries all four canonical values; every A capture lacks all three DashScope-specific headers. Authorization captured as 'Bearer <redacted>'; no tokens/prompts/bodies printed.",
		},
	};

	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

	const fmt = (s: Stats): string =>
		`median=${s.median.toFixed(1)}ms p90=${s.p90.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms mean=${s.mean.toFixed(1)}ms stddev=${s.stddev.toFixed(1)}ms`;
	process.stderr.write(
		[
			`\n# Alibaba Token Plan header-parity A/B (SYNTHETIC loopback smoke test)`,
			`Upstream: QwenLM/qwen-code @${QWEN_CODE_UPSTREAM_COMMIT} v${QWEN_CODE_UPSTREAM_VERSION}`,
			``,
			`A (legacy/mismatched): n=${statsA.n} success=${statsA.success} err=${statsA.error} to=${statsA.timeout}`,
			`  TTFT  ${fmt(statsA.ttft)}`,
			`  total ${fmt(statsA.total)}`,
			`B (Qwen-identical):   n=${statsB.n} success=${statsB.success} err=${statsB.error} to=${statsB.timeout}`,
			`  TTFT  ${fmt(statsB.ttft)}`,
			`  total ${fmt(statsB.total)}`,
			``,
			`Wire (exact per-capture): arm-B every capture full canonical ${everyBHasFullCanonical ? "PASS ✓" : "FAIL ✗"} (${armBCaptures.length} captures) | arm-A no DashScope headers ${!armAHasAnyDashscope ? "PASS ✓" : "LEAKED ✗"} (${armACaptures.length} captures)`,
			`Note: SYNTHETIC loopback smoke test (raw fetch, not production SDK shape). Local server only; no live Alibaba credentials used. Authorization redacted.`,
			``,
		].join("\n"),
	);
}

await main();
