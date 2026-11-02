import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const SHARED_NAME = "gjc-herdr-sequence-v1";
const SHARED_WATERMARK = path.join(os.tmpdir(), SHARED_NAME);
const SENTINEL = "8000000000000000";
const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

function privateWatermark(home: string): string {
	return path.join(home, ".gjc", "agent", SHARED_NAME);
}

function childEnv(home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (
			key === "GJC_CODING_AGENT_DIR" ||
			key === "PI_CODING_AGENT_DIR" ||
			key === "GJC_CONFIG_DIR" ||
			key === "PI_CONFIG_DIR" ||
			key === "XDG_CONFIG_HOME" ||
			key === "XDG_STATE_HOME" ||
			key === "XDG_DATA_HOME" ||
			key === "XDG_CACHE_HOME"
		) {
			continue;
		}
		env[key] = value;
	}
	env.HOME = home;
	env.USERPROFILE = home;
	return env;
}

function makeHome(): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-seq-home-"));
	homes.push(home);
	return home;
}

interface SharedSnapshot {
	existed: boolean;
	text?: string;
}

function snapshotShared(): SharedSnapshot {
	try {
		return { existed: true, text: fs.readFileSync(SHARED_WATERMARK, "utf8") };
	} catch {
		return { existed: false };
	}
}

function restoreShared(snapshot: SharedSnapshot): void {
	if (!snapshot.existed) {
		fs.rmSync(SHARED_WATERMARK, { force: true });
		return;
	}
	fs.rmSync(SHARED_WATERMARK, { force: true });
	fs.writeFileSync(SHARED_WATERMARK, snapshot.text ?? "", "utf8");
}

/**
 * `main` imports this module, and `createHerdrReporter` seeds the same watermark.
 * A fresh process is required because the floor is read once at module load.
 */
async function runReporter(home: string): Promise<{ code: number; stderr: string }> {
	const href = pathToFileURL(path.join(import.meta.dir, "../src/utils/herdr-pane.ts")).href;
	const script = `
		const { createHerdrReporter } = await import(${JSON.stringify(href)});
		createHerdrReporter(
			{ paneId: "pane-7", binPath: "/usr/bin/herdr" },
			() => () => {},
			{ spawn() { return { exited: Promise.resolve(0), kill() {}, unref() {} }; } },
		);
	`;
	const proc = Bun.spawn([process.execPath, "-e", script], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		env: childEnv(home),
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	return { code, stderr };
}

function readInteger(file: string): number | undefined {
	try {
		const value = Number.parseInt(fs.readFileSync(file, "utf8"), 10);
		return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

describe("Herdr sequence watermark", () => {
	test("keeps a rising Herdr sequence watermark across processes", async () => {
		const home = makeHome();
		const first = await runReporter(home);
		expect(first.code, first.stderr).toBe(0);
		const stored = readInteger(privateWatermark(home)) ?? readInteger(SHARED_WATERMARK);
		expect(stored).toEqual(expect.any(Number));
		const second = await runReporter(home);
		expect(second.code, second.stderr).toBe(0);
		const next = readInteger(privateWatermark(home)) ?? readInteger(SHARED_WATERMARK);
		expect(next).toBeGreaterThan(stored ?? 0);
		const file = fs.existsSync(privateWatermark(home)) ? privateWatermark(home) : SHARED_WATERMARK;
		if (process.platform !== "win32") {
			expect(fs.statSync(file).mode & 0o077).toBe(0);
		}
	});

	test("does not adopt a planted shared temp Herdr sequence file", async () => {
		const home = makeHome();
		const snapshot = snapshotShared();
		try {
			fs.writeFileSync(SHARED_WATERMARK, SENTINEL, { mode: 0o644 });
			const result = await runReporter(home);
			expect(result.code, result.stderr).toBe(0);
			expect(fs.readFileSync(SHARED_WATERMARK, "utf8")).toBe(SENTINEL);
			const adopted = readInteger(privateWatermark(home));
			if (adopted !== undefined) expect(adopted).toBeLessThan(Number(SENTINEL));
		} finally {
			restoreShared(snapshot);
		}
	});

	test.skipIf(process.platform === "win32")("does not follow a shared temp Herdr sequence symlink", async () => {
		const home = makeHome();
		const planted = path.join(home, "planted-sequence");
		fs.writeFileSync(planted, SENTINEL, "utf8");
		const snapshot = snapshotShared();
		fs.rmSync(SHARED_WATERMARK, { force: true });
		try {
			fs.symlinkSync(planted, SHARED_WATERMARK);
		} catch (error) {
			restoreShared(snapshot);
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPERM" || code === "EACCES") {
				expect(code).toBe("symlink-privilege");
			}
			throw error;
		}
		try {
			const result = await runReporter(home);
			expect(result.code, result.stderr).toBe(0);
			expect(fs.lstatSync(SHARED_WATERMARK).isSymbolicLink()).toBe(true);
			expect(fs.readFileSync(planted, "utf8")).toBe(SENTINEL);
		} finally {
			fs.rmSync(SHARED_WATERMARK, { force: true });
			restoreShared(snapshot);
		}
	});

	test.skipIf(process.platform === "win32")(
		"finishes Herdr reporting when the account sequence path is a fifo",
		async () => {
			const home = makeHome();
			const fifo = privateWatermark(home);
			fs.mkdirSync(path.dirname(fifo), { recursive: true });
			const made = Bun.spawnSync(["mkfifo", fifo]);
			expect(made.exitCode, made.stderr.toString()).toBe(0);
			const result = await runReporter(home);
			expect(result.code, result.stderr).toBe(0);
			expect(fs.lstatSync(fifo).isFIFO()).toBe(false);
		},
	);
});
