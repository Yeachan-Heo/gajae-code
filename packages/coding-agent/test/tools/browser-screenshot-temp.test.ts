import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@gajae-code/utils/snowflake";
import type { Browser, Page } from "puppeteer-core";
import type { Transport, WorkerInbound, WorkerOutbound } from "../../src/tools/browser/tab-protocol";
import { __setLoadPuppeteerInWorkerForTest, WorkerCore } from "../../src/tools/browser/tab-worker";

const tempDirs: string[] = [];
const plantedLinks: string[] = [];
const CAPTURED = Buffer.from("NOT-A-PNG-BYTES");

function canSymlink(): boolean {
	const parent = process.env.GJC_SCREENSHOT_CWD || os.tmpdir();
	const dir = fs.mkdtempSync(path.join(parent, "gjc-sshots-link-probe-"));
	const target = path.join(dir, "target");
	const link = path.join(dir, "link");
	fs.writeFileSync(target, "x");
	try {
		fs.symlinkSync(target, link);
		return fs.lstatSync(link).isSymbolicLink();
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const symlinkOk = canSymlink();

afterEach(() => {
	__setLoadPuppeteerInWorkerForTest(undefined);
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const link of plantedLinks.splice(0)) {
		try {
			const stat = fs.lstatSync(link);
			if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(link);
		} catch {
			// The writer may already have removed the planted link.
		}
	}
});

function rememberOutput(dest: string): void {
	const parent = path.dirname(dest);
	const base = path.basename(dest);
	if (parent !== os.tmpdir() && path.basename(parent).startsWith("gjc-sshots-")) {
		tempDirs.push(parent);
		return;
	}
	if (parent === os.tmpdir() && base.startsWith("gjc-sshots-")) plantedLinks.push(dest);
}

function makeDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

class FakeTransport {
	readonly sent: Array<WorkerOutbound | WorkerInbound> = [];
	#handlers = new Set<(msg: WorkerOutbound | WorkerInbound) => void>();

	send(msg: WorkerOutbound | WorkerInbound): void {
		this.sent.push(msg);
		for (const handler of [...this.#handlers]) handler(msg);
	}

	onMessage(handler: (msg: WorkerOutbound | WorkerInbound) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	close(): void {}

	dispatch(msg: WorkerInbound): void {
		for (const handler of [...this.#handlers]) handler(msg);
	}
}

function createPage(): Page {
	const page = {
		url: () => "https://example.com/",
		title: async () => "Fake title",
		viewport: () => ({ width: 1, height: 1 }),
		isClosed: () => false,
		on: () => {},
		off: () => {},
		close: async () => {},
		target: () => ({ _targetId: "target-1" }),
		screenshot: async () => CAPTURED,
	};
	return page as unknown as Page;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = performance.now();
	for (;;) {
		try {
			if (predicate()) return;
		} catch {
			// Result is not ready yet.
		}
		if (performance.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await Bun.sleep(1);
	}
}

async function createHarness(cwd: string) {
	const page = createPage();
	const browser = {
		targets: () => [{ _targetId: "target-1", page: async () => page }],
		connected: false,
		disconnect: () => {},
		wsEndpoint: () => "ws://fake",
		newPage: async () => page,
		close: async () => {},
	} as unknown as Browser;
	const transport = new FakeTransport();
	__setLoadPuppeteerInWorkerForTest(async () => ({ connect: async () => browser }) as never);
	new WorkerCore(transport as unknown as Transport);
	transport.dispatch({
		type: "init",
		payload: {
			mode: "attach",
			browserWSEndpoint: "ws://fake",
			safeDir: cwd,
			targetId: "target-1",
		},
	});
	await waitFor(() => transport.sent.some(msg => msg.type === "ready" || msg.type === "init-failed"));
	const initFailed = transport.sent.find(msg => msg.type === "init-failed");
	if (initFailed && initFailed.type === "init-failed") {
		throw new Error(initFailed.error.message);
	}
	return {
		async run(code: string, session: { cwd: string; browserScreenshotDir?: string }) {
			const id = `shot-${crypto.randomUUID()}`;
			transport.dispatch({ type: "run", id, name: "main", code, timeoutMs: 5_000, session });
			await waitFor(() => transport.sent.some(msg => msg.type === "result" && msg.id === id));
			const result = transport.sent.find(msg => msg.type === "result" && msg.id === id);
			if (result?.type !== "result") throw new Error("missing screenshot result");
			return result;
		},
	};
}

function shotDest(result: Extract<WorkerOutbound, { type: "result" }>): string {
	if (!result.ok) throw new Error(result.error.message);
	const shots = result.payload.screenshots as Array<{ dest: string }>;
	const dest = shots[0]?.dest;
	if (!dest) throw new Error("screenshot did not return a path");
	return dest;
}

describe("browser screenshot temp file", () => {
	it("still saves a screenshot when no temp symlink is planted", async () => {
		const cwd = makeDir("gjc-sshots-keep-");
		const harness = await createHarness(cwd);
		const result = await harness.run("await tab.screenshot({ silent: true })", { cwd });
		expect(result.ok).toBe(true);
		const dest = shotDest(result);
		rememberOutput(dest);
		expect(fs.readFileSync(dest).equals(CAPTURED)).toBe(true);
		expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
	});

	it("still writes an explicit save path", async () => {
		const cwd = makeDir("gjc-sshots-save-");
		const harness = await createHarness(cwd);
		const result = await harness.run('await tab.screenshot({ silent: true, save: "kept.png" })', { cwd });
		expect(result.ok).toBe(true);
		const dest = path.join(cwd, "kept.png");
		expect(shotDest(result)).toBe(dest);
		expect(fs.readFileSync(dest).equals(CAPTURED)).toBe(true);
	});

	it("still saves a screenshot when the temp root does not exist yet", async () => {
		const holder = makeDir("gjc-sshots-missing-holder-");
		const cwd = path.join(holder, "cwd");
		fs.mkdirSync(cwd);
		const missing = path.join(holder, "absent-root");
		const workerEntry = path.resolve(import.meta.dir, "../../src/tools/browser/tab-worker.ts");
		const scriptPath = path.join(holder, "missing-root.ts");
		fs.writeFileSync(
			scriptPath,
			`import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __setLoadPuppeteerInWorkerForTest, WorkerCore } from ${JSON.stringify(workerEntry)};
const cwd = ${JSON.stringify(cwd)};
const captured = Buffer.from("NOT-A-PNG-BYTES");
const page = {
	url: () => "https://example.com/",
	title: async () => "Fake title",
	viewport: () => ({ width: 1, height: 1 }),
	isClosed: () => false,
	on() {},
	off() {},
	close: async () => {},
	target: () => ({ _targetId: "target-1" }),
	screenshot: async () => captured,
};
const browser = {
	targets: () => [{ _targetId: "target-1", page: async () => page }],
	connected: false,
	disconnect() {},
	wsEndpoint: () => "ws://fake",
	newPage: async () => page,
	close: async () => {},
};
const sent = [];
const handlers = new Set();
const transport = {
	send(msg) {
		sent.push(msg);
		for (const handler of handlers) handler(msg);
	},
	onMessage(handler) {
		handlers.add(handler);
		return () => handlers.delete(handler);
	},
	close() {},
	dispatch(msg) {
		for (const handler of handlers) handler(msg);
	},
};
try {
__setLoadPuppeteerInWorkerForTest(async () => ({ connect: async () => browser }));
new WorkerCore(transport);
transport.dispatch({
	type: "init",
	payload: { mode: "attach", browserWSEndpoint: "ws://fake", safeDir: cwd, targetId: "target-1" },
});
const readyAt = performance.now();
while (!sent.some((msg) => msg.type === "ready" || msg.type === "init-failed")) {
	if (performance.now() - readyAt > 5000) throw new Error("ready timeout");
	await Bun.sleep(1);
}
const failed = sent.find((msg) => msg.type === "init-failed");
if (failed) throw new Error(failed.error.message);
transport.dispatch({
	type: "run",
	id: "missing-root",
	name: "main",
	code: "await tab.screenshot({ silent: true })",
	timeoutMs: 5000,
	session: { cwd },
});
const runAt = performance.now();
while (!sent.some((msg) => msg.type === "result" && msg.id === "missing-root")) {
	if (performance.now() - runAt > 5000) throw new Error("run timeout");
	await Bun.sleep(1);
}
const result = sent.find((msg) => msg.type === "result" && msg.id === "missing-root");
if (!result?.ok) throw new Error(result?.error?.message ?? "screenshot failed");
const dest = result.payload.screenshots?.[0]?.dest;
if (!dest) throw new Error("missing dest");
if (!fs.existsSync(os.tmpdir())) throw new Error("temp root was not created");
if (!fs.readFileSync(dest).equals(captured)) throw new Error("bytes mismatch");
const parentName = path.basename(path.dirname(dest));
if (process.platform !== "win32" && parentName.startsWith("gjc-sshots-")) {
	if ((fs.statSync(dest).mode & 0o777) !== 0o600) throw new Error("file mode");
	if ((fs.statSync(path.dirname(dest)).mode & 0o777) !== 0o700) throw new Error("dir mode");
}
fs.writeFileSync(${JSON.stringify(path.join(holder, "result"))}, "MISSING_ROOT_OK");
} catch (error) {
fs.writeFileSync(${JSON.stringify(path.join(holder, "result"))}, error instanceof Error ? error.stack ?? error.message : String(error));
process.exit(1);
}
`,
		);
		const childEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value === undefined) continue;
			if (
				key === "GJC_LOG_DIR" ||
				key === "GJC_TEST_PRELOAD_LOG_DIR_PROVENANCE" ||
				key === "GJC_TEST_PRELOAD_PROFILE_AUTHORITY"
			) {
				continue;
			}
			childEnv[key] = value;
		}
		childEnv.TMPDIR = missing;
		childEnv.CI = "1";
		childEnv.TERM = "dumb";
		const child = Bun.spawn([process.execPath, scriptPath], {
			cwd: holder,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const resultPath = path.join(holder, "result");
		const resultText = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, "utf8") : "";
		if (code !== 0 || resultText !== "MISSING_ROOT_OK") {
			throw new Error(
				`missing-root child code=${code} result=${JSON.stringify(resultText)} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
			);
		}
	});

	it("still saves into the configured screenshot directory", async () => {
		const cwd = makeDir("gjc-sshots-dir-");
		const configured = path.join(cwd, "shots");
		fs.mkdirSync(configured);
		const harness = await createHarness(cwd);
		const result = await harness.run("await tab.screenshot({ silent: true })", {
			cwd,
			browserScreenshotDir: configured,
		});
		expect(result.ok).toBe(true);
		const dest = shotDest(result);
		expect(path.dirname(dest)).toBe(configured);
		expect(fs.readFileSync(dest).equals(CAPTURED)).toBe(true);
	});

	if (!symlinkOk) {
		it.skip("does not follow a preexisting symlink at the predictable temp name", () => {});
	}
	if (symlinkOk)
		it("does not follow a preexisting symlink at the predictable temp name", async () => {
			const cwd = makeDir("gjc-sshots-victim-");
			const victim = path.join(cwd, "victim");
			fs.writeFileSync(victim, "SAFE");
			const harness = await createHarness(cwd);
			const now = Date.now;
			const fixed = 1_700_000_000_000;
			Date.now = () => fixed;
			try {
				const observed = Snowflake.next();
				const nextSeq = (Snowflake.getSequence(observed) + 1) & Snowflake.MAX_SEQUENCE;
				const id = Snowflake.formatParts(fixed - Snowflake.EPOCH_TIMESTAMP, nextSeq);
				const linkPath = path.join(os.tmpdir(), `gjc-sshots-${id}.png`);
				plantedLinks.push(linkPath);
				try {
					fs.unlinkSync(linkPath);
				} catch {
					// No prior file at the predicted name.
				}
				fs.symlinkSync(victim, linkPath);
				const result = await harness.run("await tab.screenshot({ silent: true })", { cwd });
				expect(result.ok).toBe(true);
				const dest = shotDest(result);
				rememberOutput(dest);
				expect(fs.readFileSync(victim, "utf8")).toBe("SAFE");
				expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
				expect(fs.readFileSync(dest).equals(CAPTURED)).toBe(true);
				if (process.platform !== "win32") {
					expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
					expect(fs.statSync(path.dirname(dest)).mode & 0o777).toBe(0o700);
				}
			} finally {
				Date.now = now;
			}
		});
});
