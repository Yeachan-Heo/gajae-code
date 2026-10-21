import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";

const LOGGER_SOURCE = path.resolve(import.meta.dir, "../src/logger.ts");

function localStamp(offsetDays: number): string {
	const date = new Date();
	date.setDate(date.getDate() + offsetDays);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

interface WrittenLog {
	name: string;
	mode: number;
	body: string;
}

interface ProbeResult {
	dirMode: number;
	written: WrittenLog[];
}

function writeProbe(root: string): string {
	const script = path.join(root, "probe.ts");
	const source = [
		'import * as fs from "node:fs";',
		'import * as path from "node:path";',
		`import * as logger from ${JSON.stringify(LOGGER_SOURCE)};`,
		"process.umask(0o022);",
		"const logDir = process.argv[2];",
		"logger.setTransports({ file: logDir, console: false });",
		'logger.info("rotating-log-mode-marker");',
		"const deadline = Date.now() + 8000;",
		"let written: { name: string; mode: number; body: string }[] = [];",
		"while (Date.now() < deadline) {",
		"  written = [];",
		"  let names: string[] = [];",
		"  try { names = fs.readdirSync(logDir); } catch { names = []; }",
		"  for (const name of names) {",
		'    if (!name.endsWith(".log")) continue;',
		"    const full = path.join(logDir, name);",
		"    const stat = fs.lstatSync(full);",
		"    if (!stat.isFile()) continue;",
		'    let body = "";',
		'    try { body = fs.readFileSync(full, "utf8"); } catch { continue; }',
		'    if (!body.includes("rotating-log-mode-marker")) continue;',
		"    written.push({ name, mode: stat.mode & 0o777, body });",
		"  }",
		"  if (written.length > 0) break;",
		"  await new Promise((resolve) => setTimeout(resolve, 40));",
		"}",
		"if (written.length === 0) { console.error('marker not written'); process.exit(1); }",
		"console.log(JSON.stringify({ dirMode: fs.lstatSync(logDir).mode & 0o777, written }));",
	].join("\n");
	fs.writeFileSync(script, source);
	return script;
}

async function runProbe(logDir: string, home: string, cwd = path.dirname(logDir)): Promise<ProbeResult> {
	const script = writeProbe(cwd);
	const proc = Bun.spawn([process.execPath, script, logDir], {
		cwd,
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			USERPROFILE: home,
			TMPDIR: os.tmpdir(),
			CI: "1",
			TERM: "dumb",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`probe exit ${exitCode}: ${stderr}`);
	const line = stdout.trim().split("\n").pop() ?? "";
	return JSON.parse(line) as ProbeResult;
}

/** Root ignores mode bits, so an unopenable-mode fixture is not unopenable. */
function rootBypassesFileMode(): boolean {
	return typeof process.geteuid === "function" && process.geteuid() === 0;
}

/** True when this process cannot create a symlink. Those tests must skip, not pass. */
function symlinkCreationDenied(): boolean {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-symlink-"));
	const target = path.join(root, "target");
	const link = path.join(root, "link");
	try {
		fs.mkdirSync(target);
		fs.symlinkSync(target, link);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		throw error;
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const symlinkDenied = symlinkCreationDenied();

function captureStream(which: "stdout" | "stderr"): { text(): string; restore(): void } {
	const lines: string[] = [];
	const stream = which === "stdout" ? process.stdout : process.stderr;
	const method = which === "stdout" ? "log" : "error";
	const consoleSpy = spyOn(console, method).mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	});
	const writeSpy = spyOn(stream, "write").mockImplementation((chunk: unknown) => {
		lines.push(String(chunk));
		return true;
	});
	return {
		text: () => lines.join("\n"),
		restore() {
			consoleSpy.mockRestore();
			writeSpy.mockRestore();
		},
	};
}

async function settleTransport(): Promise<void> {
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));
}

async function waitForText(captured: { text(): string }, needle: string): Promise<boolean> {
	for (let i = 0; i < 30; i++) {
		if (captured.text().includes(needle)) return true;
		await new Promise(resolve => setImmediate(resolve));
	}
	return captured.text().includes(needle);
}

async function readActiveLog(logDir: string, needle: string): Promise<string> {
	const file = path.join(logDir, `gjc.${localStamp(0)}.log`);
	let body = "";
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		try {
			body = fs.readFileSync(file, "utf8");
		} catch {
			body = "";
		}
		if (body.includes(needle)) return body;
		await new Promise(resolve => setTimeout(resolve, 40));
	}
	return body;
}

describe.skipIf(process.platform === "win32")("rotating log owner-only mode", () => {
	it("still reads a rotating log line the owner wrote", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-home-"));
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
		try {
			const result = await runProbe(path.join(root, "logs"), home);
			expect(result.written.length).toBeGreaterThan(0);
			expect(result.written.some(file => file.body.includes("rotating-log-mode-marker"))).toBe(true);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	it("creates the directory at 0700 and the log file at 0600", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-home-"));
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
		try {
			const result = await runProbe(path.join(root, "logs"), home);
			expect(result.dirMode).toBe(0o700);
			expect(result.written.length).toBeGreaterThan(0);
			for (const file of result.written) expect(file.mode).toBe(0o600);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	async function expectSymlinkTargetUnchanged(logDirFor: (link: string) => string): Promise<void> {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-home-"));
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
		const target = path.join(root, "target");
		const link = path.join(root, "link");
		try {
			fs.mkdirSync(target);
			fs.chmodSync(target, 0o755);
			fs.symlinkSync(target, link);
			await runProbe(logDirFor(link), home);
			expect(fs.lstatSync(target).mode & 0o777).toBe(0o755);
			expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
			const text = fs
				.readdirSync(target)
				.filter(name => name.endsWith(".log"))
				.map(name => fs.readFileSync(path.join(target, name), "utf8"))
				.join("");
			expect(text).toContain("rotating-log-mode-marker");
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	}

	it("still reads through a symlink log directory and leaves the target mode", async () => {
		await expectSymlinkTargetUnchanged(link => link);
	}, 20_000);

	it("still reads through dot-suffix symlink log directories and leaves the target mode", async () => {
		for (const suffix of ["/.", "/./", "/./."]) {
			await expectSymlinkTargetUnchanged(link => `${link}${suffix}`);
		}
	}, 20_000);

	it("tightens an existing 0755 directory and 0666 log file", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-home-"));
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
		const logDir = path.join(root, "logs");
		try {
			fs.mkdirSync(logDir);
			fs.chmodSync(logDir, 0o755);
			for (const offset of [-1, 0, 1]) {
				const file = path.join(logDir, `gjc.${localStamp(offset)}.log`);
				fs.writeFileSync(file, "prior-line\n");
				fs.chmodSync(file, 0o666);
			}
			const result = await runProbe(logDir, home);
			expect(result.dirMode).toBe(0o700);
			expect(result.written.length).toBeGreaterThan(0);
			for (const file of result.written) {
				expect(file.mode).toBe(0o600);
				expect(file.body).toContain("prior-line");
				expect(file.body).toContain("rotating-log-mode-marker");
			}
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	it("still writes a rotating log into a directory whose name ends in a backslash", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-home-"));
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
		const sibling = path.join(root, "logs");
		const named = path.join(root, "logs\\");
		try {
			fs.mkdirSync(sibling);
			fs.chmodSync(sibling, 0o755);
			fs.writeFileSync(path.join(sibling, "keep.txt"), "sibling-keep\n");
			const result = await runProbe(named, home);
			expect(result.written.some(file => file.body.includes("rotating-log-mode-marker"))).toBe(true);
			expect(fs.readdirSync(root)).toContain("logs\\");
			expect(fs.lstatSync(sibling).mode & 0o777).toBe(0o755);
			expect(fs.readFileSync(path.join(sibling, "keep.txt"), "utf8")).toBe("sibling-keep\n");
			expect(fs.readdirSync(sibling).some(name => name.endsWith(".log"))).toBe(false);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	it("tightens a 0666 log under a symlinked directory and leaves the target mode", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-home-"));
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
		const target = path.join(root, "target");
		const link = path.join(root, "link");
		const file = path.join(target, `gjc.${localStamp(0)}.log`);
		try {
			fs.mkdirSync(target);
			fs.chmodSync(target, 0o755);
			fs.writeFileSync(file, "prior-line\n");
			fs.chmodSync(file, 0o666);
			fs.symlinkSync(target, link);
			const result = await runProbe(link, home);
			expect(fs.lstatSync(target).mode & 0o777).toBe(0o755);
			expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
			expect(fs.lstatSync(file).isFile()).toBe(true);
			expect(fs.lstatSync(file).mode & 0o777).toBe(0o600);
			expect(result.written.some(entry => entry.body.includes("prior-line"))).toBe(true);
			expect(result.written.some(entry => entry.body.includes("rotating-log-mode-marker"))).toBe(true);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	it("tightens an existing log file at mode 0266", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-home-"));
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
		const logDir = path.join(root, "logs");
		const file = path.join(logDir, `gjc.${localStamp(0)}.log`);
		try {
			fs.mkdirSync(logDir);
			fs.chmodSync(logDir, 0o755);
			fs.writeFileSync(file, "prior-line\n");
			fs.chmodSync(file, 0o266);
			const result = await runProbe(logDir, home);
			expect(result.dirMode).toBe(0o700);
			expect(fs.lstatSync(file).mode & 0o777).toBe(0o600);
			expect(result.written.some(entry => entry.body.includes("prior-line"))).toBe(true);
			expect(result.written.some(entry => entry.body.includes("rotating-log-mode-marker"))).toBe(true);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	it("still tightens an owner-readable log at mode 0466", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-home-"));
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
		const logDir = path.join(root, "logs");
		const file = path.join(logDir, `gjc.${localStamp(0)}.log`);
		const logger = await import("../src/logger");
		try {
			fs.mkdirSync(logDir);
			fs.chmodSync(logDir, 0o700);
			fs.writeFileSync(file, "prior-line\n");
			fs.chmodSync(file, 0o466);
			logger.setTransports({ file: logDir, console: false });
			logger.info("rotating-log-mode-marker");
			const deadline = Date.now() + 8000;
			let mode = fs.lstatSync(file).mode & 0o777;
			while (Date.now() < deadline && mode !== 0o600) {
				mode = fs.lstatSync(file).mode & 0o777;
				if (mode === 0o600) break;
				await new Promise(resolve => setTimeout(resolve, 40));
			}
			expect(mode).toBe(0o600);
			expect(fs.readFileSync(file, "utf8")).toContain("prior-line");
		} finally {
			logger.setTransports({ file: false, console: false });
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	it("does not chmod filesystem-root spellings and does not follow a symlink log file", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-home-"));
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
		const logDir = path.join(root, "logs");
		const real = path.join(root, "real.log");
		const rootStat = fs.statSync("/");
		let privateStat: fs.Stats | undefined;
		try {
			privateStat = fs.statSync("/private");
		} catch {
			privateStat = undefined;
		}
		const seen: string[] = [];
		const original = fs.fchmodSync;
		const spy = spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
			const st = fs.fstatSync(fd);
			if (st.dev === rootStat.dev && st.ino === rootStat.ino) {
				seen.push("root");
				return;
			}
			if (privateStat && st.dev === privateStat.dev && st.ino === privateStat.ino) {
				seen.push("private");
				return;
			}
			return original(fd, mode);
		});
		const logger = await import("../src/logger");
		try {
			fs.mkdirSync(logDir);
			logger.setTransports({ file: logDir, console: false });
			logger.info("rotating-log-mode-marker");
			const deadline = Date.now() + 8000;
			let marked = false;
			while (Date.now() < deadline) {
				const names = fs.readdirSync(logDir).filter(name => name.endsWith(".log"));
				marked = names.some(name =>
					fs.readFileSync(path.join(logDir, name), "utf8").includes("rotating-log-mode-marker"),
				);
				if (marked) break;
				await new Promise(resolve => setTimeout(resolve, 40));
			}
			expect(marked).toBe(true);
			expect(fs.statSync(logDir).mode & 0o777).toBe(0o700);
			const rootBefore = fs.statSync("/").mode;
			const privateBefore = privateStat?.mode;
			seen.length = 0;
			const rootAliases = [
				"/",
				"/.",
				`${path.posix.sep}tmp${path.posix.sep}..`,
				`${path.posix.sep}tmp${path.posix.sep}..${path.posix.sep}`,
			];
			for (const alias of rootAliases) {
				logger.setTransports({ file: alias, console: false });
				logger.info("root-alias-marker");
			}
			expect(seen).toEqual([]);
			expect(fs.statSync("/").mode).toBe(rootBefore);
			if (privateStat && privateBefore !== undefined) expect(fs.statSync("/private").mode).toBe(privateBefore);

			fs.writeFileSync(real, "kept\n");
			fs.chmodSync(real, 0o644);
			const linkLogs = path.join(root, "linklogs");
			fs.mkdirSync(linkLogs);
			fs.chmodSync(linkLogs, 0o700);
			const link = path.join(linkLogs, `gjc.${localStamp(0)}.log`);
			fs.symlinkSync(real, link);
			logger.setTransports({ file: linkLogs, console: false });
			logger.info("symlink-file-marker");
			const linkDeadline = Date.now() + 8000;
			let followed = false;
			while (Date.now() < linkDeadline) {
				followed = fs.readFileSync(real, "utf8").includes("symlink-file-marker");
				if (followed) break;
				await new Promise(resolve => setTimeout(resolve, 40));
			}
			expect(followed).toBe(true);
			expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
			expect(fs.lstatSync(real).mode & 0o777).toBe(0o644);
		} finally {
			spy.mockRestore();
			logger.setTransports({ file: false, console: false });
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	it.skipIf(symlinkDenied)(
		"does not chmod the filesystem root when a parent link is retargeted",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
			const parent = path.join(root, "parent");
			const child = path.join(parent, "child");
			const link = path.join(parent, "link");
			const safe = path.join(root, "safe");
			const alias = `${link}${path.sep}..`;
			const rootBefore = fs.statSync("/").mode;
			const rootStat = fs.statSync("/");
			const seen: string[] = [];
			const originalFchmod = fs.fchmodSync;
			const native = fs.realpathSync.native;
			let fchmodSpy: { mockRestore(): void } | undefined;
			let realSpy: { mockRestore(): void } | undefined;
			const logger = await import("../src/logger");
			try {
				fs.mkdirSync(child, { recursive: true });
				fs.mkdirSync(safe);
				fs.symlinkSync(child, link);
				fs.chmodSync(parent, 0o755);
				logger.setTransports({ file: safe, console: false });
				logger.info("rotating-log-mode-marker");
				const ready = Date.now() + 8000;
				let marked = false;
				while (Date.now() < ready) {
					const names = fs.existsSync(safe) ? fs.readdirSync(safe).filter(name => name.endsWith(".log")) : [];
					marked = names.some(name =>
						fs.readFileSync(path.join(safe, name), "utf8").includes("rotating-log-mode-marker"),
					);
					if (marked) break;
					await new Promise(resolve => setTimeout(resolve, 40));
				}
				expect(marked).toBe(true);
				let armed = false;
				fchmodSpy = spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
					const st = fs.fstatSync(fd);
					if (st.dev === rootStat.dev && st.ino === rootStat.ino) {
						seen.push("root");
						return;
					}
					return originalFchmod(fd, mode);
				});
				realSpy = spyOn(fs.realpathSync, "native").mockImplementation(((target: fs.PathLike) => {
					const resolved = native(target);
					if (!armed && String(target).includes(`${path.sep}link${path.sep}`)) {
						armed = true;
						fs.unlinkSync(link);
						fs.symlinkSync("/", link);
					}
					return resolved;
				}) as typeof fs.realpathSync.native);
				logger.setTransports({ file: alias, console: false });
				logger.info("root-race-marker");
				expect(armed).toBe(true);
				expect(seen).toEqual([]);
				expect(fs.statSync("/").mode).toBe(rootBefore);
			} finally {
				realSpy?.mockRestore();
				fchmodSpy?.mockRestore();
				logger.setTransports({ file: false, console: false });
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
		20_000,
	);

	it.skipIf(symlinkDenied)(
		"still writes a rotating log through a dot-segment directory",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
			const parent = path.join(root, "parent");
			const child = path.join(parent, "child");
			const link = path.join(parent, "link");
			const alias = `${link}${path.sep}..`;
			const rootBefore = fs.statSync("/").mode;
			const logger = await import("../src/logger");
			try {
				fs.mkdirSync(child, { recursive: true });
				fs.symlinkSync(child, link);
				fs.chmodSync(parent, 0o755);
				logger.setTransports({ file: alias, console: false });
				logger.info("rotating-log-mode-marker");
				const deadline = Date.now() + 8000;
				let marked = false;
				while (Date.now() < deadline) {
					const names = fs.readdirSync(parent).filter(name => name.endsWith(".log"));
					marked = names.some(name =>
						fs.readFileSync(path.join(parent, name), "utf8").includes("rotating-log-mode-marker"),
					);
					if (marked) break;
					await new Promise(resolve => setTimeout(resolve, 40));
				}
				expect(marked).toBe(true);
				expect(fs.statSync("/").mode).toBe(rootBefore);
				expect(fs.statSync(parent).isDirectory()).toBe(true);
			} finally {
				logger.setTransports({ file: false, console: false });
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
		20_000,
	);

	it.skipIf(rootBypassesFileMode())(
		"leaves an unopenable log file at mode 0004 without stderr",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
			const logDir = path.join(root, "logs");
			const file = path.join(logDir, `gjc.${localStamp(0)}.log`);
			const stderr = captureStream("stderr");
			const logger = await import("../src/logger");
			try {
				fs.mkdirSync(logDir);
				fs.chmodSync(logDir, 0o700);
				fs.writeFileSync(file, "prior-line\n");
				fs.chmodSync(file, 0o004);
				logger.setTransports({ file: logDir, console: false });
				logger.info("rotating-log-mode-marker");
				await settleTransport();
				expect(fs.lstatSync(file).mode & 0o777).toBe(0o004);
				expect(stderr.text().includes("unopenable")).toBe(false);
			} finally {
				logger.setTransports({ file: false, console: false });
				await settleTransport();
				stderr.restore();
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
		20_000,
	);

	it.skipIf(rootBypassesFileMode())(
		"reports an unopenable log file when the console transport is on",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
			const logDir = path.join(root, "logs");
			const file = path.join(logDir, `gjc.${localStamp(0)}.log`);
			const stdout = captureStream("stdout");
			const logger = await import("../src/logger");
			try {
				fs.mkdirSync(logDir);
				fs.chmodSync(logDir, 0o700);
				fs.writeFileSync(file, "prior-line\n");
				fs.chmodSync(file, 0o004);
				logger.setTransports({ file: logDir, console: true });
				logger.info("rotating-log-mode-marker");
				const seen = await waitForText(stdout, "unopenable file");
				expect(fs.lstatSync(file).mode & 0o777).toBe(0o004);
				expect(seen).toBe(true);
			} finally {
				logger.setTransports({ file: false, console: false });
				await settleTransport();
				stdout.restore();
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
		20_000,
	);

	it.skipIf(rootBypassesFileMode())(
		"leaves an unopenable directory at mode 0333 without stderr",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
			const logDir = path.join(root, "logs");
			const stderr = captureStream("stderr");
			const logger = await import("../src/logger");
			try {
				fs.mkdirSync(logDir);
				fs.chmodSync(logDir, 0o333);
				logger.setTransports({ file: logDir, console: false });
				logger.info("rotating-log-mode-marker");
				const body = await readActiveLog(logDir, "unopenable directory");
				expect(fs.lstatSync(logDir).mode & 0o777).toBe(0o333);
				expect(stderr.text().includes("unopenable")).toBe(false);
				expect(body.includes("unopenable directory")).toBe(true);
			} finally {
				logger.setTransports({ file: false, console: false });
				await settleTransport();
				stderr.restore();
				try {
					fs.chmodSync(logDir, 0o700);
				} catch {
					// The directory may already be gone.
				}
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
		20_000,
	);

	it.skipIf(symlinkDenied)(
		"does not chmod a directory swapped to a symlink after the dot-suffix check",
		async () => {
			const logger = await import("../src/logger");
			for (const suffix of ["/.", "/./", "/./."]) {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
				const logs = path.join(root, "logs");
				const victim = path.join(root, "victim");
				const parked = path.join(root, "parked");
				const original = fs.lstatSync;
				let seen = 0;
				const spy = spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike) => {
					const stat = original(target);
					if (String(target) === logs) {
						seen += 1;
						if (seen === 2) {
							fs.renameSync(logs, parked);
							fs.symlinkSync(victim, logs);
						}
					}
					return stat;
				}) as typeof fs.lstatSync);
				try {
					fs.mkdirSync(logs);
					fs.mkdirSync(victim);
					fs.chmodSync(logs, 0o755);
					fs.chmodSync(victim, 0o755);
					logger.setTransports({ file: `${logs}${suffix}`, console: false });
					logger.info("dot-suffix-swap-marker");
					await settleTransport();
					expect(seen).toBeGreaterThanOrEqual(2);
					expect(fs.lstatSync(victim).mode & 0o777).toBe(0o755);
					expect(original(logs).isSymbolicLink()).toBe(true);
				} finally {
					spy.mockRestore();
					logger.setTransports({ file: false, console: false });
					fs.rmSync(root, { recursive: true, force: true });
				}
			}
		},
		20_000,
	);

	it("does not block when a raced fifo is opened for repair", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-log-mode-"));
		const logDir = path.join(root, "logs");
		const file = path.join(logDir, `gjc.${localStamp(0)}.log`);
		const fifo = path.join(root, "pipe");
		const made = Bun.spawnSync(["mkfifo", fifo]);
		if (made.exitCode !== 0) throw new Error("mkfifo unavailable");
		const logger = await import("../src/logger");
		const originalOpen = fs.openSync;
		let sawNonblock = false;
		let openMs = 0;
		let openSpy: { mockRestore(): void } | undefined;
		try {
			fs.mkdirSync(logDir);
			fs.writeFileSync(file, "prior-line\n");
			fs.chmodSync(file, 0o666);
			fs.chmodSync(logDir, 0o755);
			logger.setTransports({ file: logDir, console: false });
			logger.info("rotating-log-mode-marker");
			const ready = Date.now() + 8000;
			let marked = false;
			while (Date.now() < ready) {
				marked = fs.readFileSync(file, "utf8").includes("rotating-log-mode-marker");
				if (marked) break;
				await new Promise(resolve => setTimeout(resolve, 40));
			}
			expect(marked).toBe(true);
			fs.chmodSync(file, 0o666);
			openSpy = spyOn(fs, "openSync").mockImplementation(
				(target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
					if (path.basename(String(target)) !== path.basename(file))
						return originalOpen(target, flags, mode ?? undefined);
					const flagNum = typeof flags === "number" ? flags : 0;
					const nonblock = fs.constants.O_NONBLOCK ?? 0;
					if (nonblock !== 0 && (flagNum & nonblock) === 0) {
						const blocked = new Error("blocking") as NodeJS.ErrnoException;
						blocked.code = "ENXIO";
						throw blocked;
					}
					sawNonblock = true;
					const started = Date.now();
					try {
						return originalOpen(fifo, flagNum, mode ?? undefined);
					} finally {
						openMs = Date.now() - started;
					}
				},
			);
			logger.setTransports({ file: logDir, console: false });
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(sawNonblock).toBe(true);
			expect(openMs).toBeLessThan(1000);
		} finally {
			openSpy?.mockRestore();
			logger.setTransports({ file: false, console: false });
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);
});

function isGeneratedSeparator(char: string, platform: "posix" | "win32"): boolean {
	return char === "/" || (platform === "win32" && char === "\\");
}

function logPathHolds(
	lexicalLogPath: (target: string, platform: "posix" | "win32") => string,
	isFsRoot: (target: string, platform: "posix" | "win32") => boolean,
	raw: string,
	platform: "posix" | "win32",
): boolean {
	const out = lexicalLogPath(raw, platform);
	if (!raw.startsWith(out)) return false;
	for (const char of raw.slice(out.length)) {
		if (!isGeneratedSeparator(char, platform)) return false;
	}
	if (lexicalLogPath(out, platform) !== out) return false;
	const ends = raw.length > 0 && isGeneratedSeparator(raw[raw.length - 1] ?? "", platform);
	if (!ends && out !== raw) return false;
	if (isFsRoot(raw, platform) && !isFsRoot(out, platform)) return false;
	if (out.length > 0 && !isFsRoot(out, platform) && isGeneratedSeparator(out[out.length - 1] ?? "", platform)) {
		return false;
	}
	if (platform === "posix") {
		if (raw.split("\\").length !== out.split("\\").length) return false;
		if (lexicalLogPath(`${raw}\\`, "posix") !== `${raw}\\`) return false;
	}
	return true;
}

it("normalizes log paths without changing a non-separator name", async () => {
	const mod = await import("../src/logger");
	const { lexicalLogPath, isFsRoot, resolvesAsFsRoot } = mod;
	if (
		typeof lexicalLogPath !== "function" ||
		typeof isFsRoot !== "function" ||
		typeof resolvesAsFsRoot !== "function"
	) {
		throw new Error("log path helpers missing");
	}
	expect(lexicalLogPath("logs\\", "posix")).toBe("logs\\");
	expect(lexicalLogPath("logs/", "posix")).toBe("logs");
	expect(lexicalLogPath("logs\\", "win32")).toBe("logs");
	expect(lexicalLogPath("C:\\", "win32")).toBe("C:\\");
	expect(lexicalLogPath("C:/", "win32")).toBe("C:/");
	expect(lexicalLogPath("C:", "win32")).toBe("C:");
	expect(isFsRoot("\\", "posix")).toBe(false);
	expect(isFsRoot("/", "posix")).toBe(true);
	expect(isFsRoot("C:\\", "win32")).toBe(true);
	expect(isFsRoot("C:", "win32")).toBe(false);
	expect(resolvesAsFsRoot("/.", "posix")).toBe(true);
	expect(resolvesAsFsRoot("/tmp/..", "posix")).toBe(true);
	expect(resolvesAsFsRoot("/tmp/../", "posix")).toBe(true);
	expect(resolvesAsFsRoot("/var/logs", "posix")).toBe(false);
	expect(resolvesAsFsRoot("logs\\", "posix")).toBe(false);
	expect(resolvesAsFsRoot("C:\\.", "win32")).toBe(true);
	expect(resolvesAsFsRoot("C:\\temp\\..", "win32")).toBe(true);
	expect(resolvesAsFsRoot("C:\\temp", "win32")).toBe(false);
	expect(resolvesAsFsRoot("C:", "win32")).toBe(false);
	fc.assert(
		fc.property(fc.string(), fc.constantFrom("posix" as const, "win32" as const), (raw, platform) =>
			logPathHolds(lexicalLogPath, isFsRoot, raw, platform),
		),
		{ seed: 209, numRuns: 128 },
	);
	fc.assert(
		fc.property(fc.string(), fc.constantFrom("posix" as const, "win32" as const), (raw, platform) => {
			const impl = platform === "win32" ? path.win32 : path.posix;
			const lexical = lexicalLogPath(raw, platform);
			const collapsed = lexicalLogPath(impl.normalize(lexical), platform);
			if (resolvesAsFsRoot(raw, platform) !== isFsRoot(collapsed, platform)) return false;
			if (isFsRoot(lexical, platform) && !resolvesAsFsRoot(raw, platform)) return false;
			if (platform === "posix" && raw.includes("\\") && !raw.includes("/"))
				return resolvesAsFsRoot(raw, "posix") === false;
			return resolvesAsFsRoot(collapsed, platform) === isFsRoot(collapsed, platform);
		}),
		{ seed: 7036, numRuns: 128 },
	);
});
