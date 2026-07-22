/**
 * ISSUE #2834 synthetic legacy-resume RSS regression benchmark.
 *
 * This creates deterministic, privacy-safe v2 JSONL transcripts at three
 * geometric record scales and opens each through the strict resume seam. On
 * Linux with `/usr/bin/time`, every shape runs in its own Bun process and the
 * report carries that external process's peak RSS; otherwise it reports only
 * in-process samples and explicitly marks external isolation unavailable.
 *
 * Run with an exposed collector for meaningful worker GC baselines:
 *   bun --expose-gc packages/coding-agent/bench/session-legacy-resume-rss.ts
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

const DEFAULT_SEED = 0x2834;
const DEFAULT_RECORD_COUNT = 64;
const DEFAULT_BODY_BYTES = 32 * 1024;
const SCALE_FACTORS = [1, 4, 16] as const;

export type ShapeMeasurement = {
	inputBytes: number;
	baselineRssBytes: number;
	strictOpenSampleRssBytes: number;
	postCloseRssBytes: number | null;
	contextMessageCount: number;
	retainedEntryCount: number;
};

export type CliArgs = {
	seed: number;
	recordCount: number;
	bodyBytes: number;
	worker?: boolean;
};

export interface LegacyResumeRssReport {
	issue: "#2834";
	fixture: "synthetic-deterministic-legacy-v2-jsonl";
	scope: "synthetic regression only; does not reproduce reporter artifacts, content, or RSS figures";
	seed: number;
	shapes: Array<{
		factor: number;
		recordCount: number;
		measurement: ShapeMeasurement;
		externalPeakRssBytes: number | null;
	}>;
	measurement: {
		processIsolated: boolean;
		externalPeak: "maxrss-kibibytes-from-/usr/bin/time" | "unavailable";
		enforcement: "report-only";
	};
}

function parsePositiveInteger(value: string, flag: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
	return parsed;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { seed: DEFAULT_SEED, recordCount: DEFAULT_RECORD_COUNT, bodyBytes: DEFAULT_BODY_BYTES };
	for (let index = 2; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--worker") {
			args.worker = true;
			continue;
		}
		const value = argv[++index];
		if (!value) throw new Error(`${flag} requires a value`);
		switch (flag) {
			case "--seed":
				args.seed = parsePositiveInteger(value, flag);
				break;
			case "--records":
				args.recordCount = parsePositiveInteger(value, flag);
				break;
			case "--body-bytes":
				args.bodyBytes = parsePositiveInteger(value, flag);
				break;
			default:
				throw new Error(`Unknown argument: ${flag}`);
		}
	}
	return args;
}

function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function deterministicText(seed: number, bytes: number): string {
	const next = mulberry32(seed);
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let text = "";
	while (text.length < bytes) text += alphabet[Math.floor(next() * alphabet.length)] ?? "x";
	return text;
}

function createTranscript(seed: number, recordCount: number, bodyBytes: number): string {
	const lines: string[] = [
		JSON.stringify({
			type: "session",
			version: 2,
			id: `synthetic-legacy-${seed}`,
			timestamp: "2020-01-01T00:00:00.000Z",
			cwd: "/synthetic/issue-2834",
		}),
	];
	let parentId: string | null = null;
	for (let index = 0; index < recordCount; index++) {
		const id = `message-${index}`;
		const body = index === 0 ? "synthetic legacy resume seed" : deterministicText(seed + index, bodyBytes);
		lines.push(
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: "2020-01-01T00:00:00.000Z",
				message: { role: "user", content: body, timestamp: 0 },
			}),
		);
		parentId = id;
	}
	return `${lines.join("\n")}\n`;
}

function forceGc(): boolean {
	const gc = (globalThis as { gc?: () => void }).gc;
	if (!gc) return false;
	gc();
	return true;
}

async function measureShape(seed: number, recordCount: number, bodyBytes: number): Promise<ShapeMeasurement> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-issue-2834-rss-"));
	try {
		const sessionDir = path.join(root, "sessions");
		const transcriptPath = path.join(sessionDir, "synthetic-legacy.jsonl");
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(transcriptPath, createTranscript(seed, recordCount, bodyBytes), "utf8");
		const before = await fs.readFile(transcriptPath);
		const inspection = await SessionManager.inspectSessionTailReadOnly(transcriptPath);
		if (inspection.kind !== "resumable") throw new Error("Strict inspection did not produce a resumable session");
		forceGc();
		const baselineRssBytes = process.memoryUsage().rss;
		const opened = await SessionManager.openExistingStrict(inspection.identity, sessionDir);
		if (opened.kind !== "opened") throw new Error(`Strict open failed: ${opened.reason}`);
		const strictOpenSampleRssBytes = process.memoryUsage().rss;
		const contextMessageCount = opened.manager.buildSessionContext().messages.length;
		const retainedEntryCount = opened.manager.getEntries().length;
		if (contextMessageCount !== recordCount || retainedEntryCount !== recordCount)
			throw new Error("Strict resume did not retain every synthetic legacy message");
		await opened.manager.close();
		if (!before.equals(await fs.readFile(transcriptPath))) throw new Error("Strict resume changed the synthetic legacy transcript");
		return {
			inputBytes: before.byteLength,
			baselineRssBytes,
			strictOpenSampleRssBytes,
			postCloseRssBytes: forceGc() ? process.memoryUsage().rss : null,
			contextMessageCount,
			retainedEntryCount,
		};
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function externalShape(args: CliArgs): Promise<{ measurement: ShapeMeasurement; externalPeakRssBytes: number | null }> {
	const timePath = process.platform === "linux" ? "/usr/bin/time" : undefined;
	if (!timePath) return { measurement: await measureShape(args.seed, args.recordCount, args.bodyBytes), externalPeakRssBytes: null };
	try {
		await fs.access(timePath);
	} catch {
		return { measurement: await measureShape(args.seed, args.recordCount, args.bodyBytes), externalPeakRssBytes: null };
	}
	const child = Bun.spawn([
		timePath,
		"-f",
		"%M",
		process.execPath,
		"--expose-gc",
		import.meta.path,
		"--worker",
		"--seed",
		String(args.seed),
		"--records",
		String(args.recordCount),
		"--body-bytes",
		String(args.bodyBytes),
	], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (exitCode !== 0) throw new Error(`Isolated benchmark failed: ${stderr}`);
	const peakKibibytes = Number(stderr.trim().split(/\s+/).at(-1));
	if (!Number.isSafeInteger(peakKibibytes) || peakKibibytes < 1) throw new Error(`Invalid /usr/bin/time peak RSS: ${stderr}`);
	return { measurement: JSON.parse(stdout) as ShapeMeasurement, externalPeakRssBytes: peakKibibytes * 1024 };
}

export async function measureLegacyResumeRss(args: CliArgs = parseArgs(Bun.argv)): Promise<LegacyResumeRssReport> {
	if (args.worker) throw new Error("Worker measurements are emitted only by the benchmark entrypoint.");
	const shapes: LegacyResumeRssReport["shapes"] = [];
	for (const factor of SCALE_FACTORS) {
		const recordCount = args.recordCount * factor;
		const result = await externalShape({ ...args, recordCount });
		shapes.push({ factor, recordCount, ...result });
	}
	return {
		issue: "#2834",
		fixture: "synthetic-deterministic-legacy-v2-jsonl",
		scope: "synthetic regression only; does not reproduce reporter artifacts, content, or RSS figures",
		seed: args.seed,
		shapes,
		measurement: {
			processIsolated: shapes.every(shape => shape.externalPeakRssBytes !== null),
			externalPeak: shapes.every(shape => shape.externalPeakRssBytes !== null)
				? "maxrss-kibibytes-from-/usr/bin/time"
				: "unavailable",
			enforcement: "report-only",
		},
	};
}

if (import.meta.main) {
	const args = parseArgs(Bun.argv);
	process.stdout.write(`${JSON.stringify(args.worker ? await measureShape(args.seed, args.recordCount, args.bodyBytes) : await measureLegacyResumeRss(args))}\n`);
}
