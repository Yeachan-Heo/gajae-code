import { afterEach, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionLogsDir } from "../src/gjc-runtime/session-layout";

const roots: string[] = [];

function symlinksAvailable(): boolean {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gjc-hook-link-"));
	try {
		fsSync.symlinkSync("target", path.join(dir, "link"));
		return true;
	} catch (error) {
		const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : "";
		if (code === "EPERM" || code === "EACCES") return false;
		throw error;
	} finally {
		fsSync.rmSync(dir, { recursive: true, force: true });
	}
}

const canSymlink = symlinksAvailable();

afterEach(async () => {
	await Promise.all(roots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hook-log-"));
	roots.push(dir);
	return dir;
}

function logFile(root: string, sessionId: string): string {
	const day = new Date().toISOString().slice(0, 10);
	return path.join(sessionLogsDir(root, sessionId), `native-hook-${day}.jsonl`);
}

function posixMode(file: string): number {
	return fsSync.lstatSync(file).mode & 0o777;
}

async function runMalformed(
	root: string,
	sessionId: string | undefined,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	if (sessionId === undefined) delete env.GJC_SESSION_ID;
	else env.GJC_SESSION_ID = sessionId;
	delete env.GJC_SESSION_FILE;
	const proc = Bun.spawn(["bun", path.resolve(import.meta.dir, "..", "src", "cli.ts"), "codex-native-hook"], {
		cwd: root,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	proc.stdin.write("{not-json");
	proc.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

it("still allows a native hook log in a new session directory", async () => {
	const root = await tempDir();
	const result = await runMalformed(root, "fresh-session");
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toContain("malformed JSON");
	expect(await fs.readFile(logFile(root, "fresh-session"), "utf8")).toContain("native_hook_stdin_parse_error");
}, 30_000);

it("still allows appending to an existing regular native hook log", async () => {
	const root = await tempDir();
	const file = logFile(root, "append-session");
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, "PRE-EXISTING\n");
	const result = await runMalformed(root, "append-session");
	expect(result.exitCode, result.stderr).toBe(0);
	const body = await fs.readFile(file, "utf8");
	expect(body.startsWith("PRE-EXISTING\n")).toBe(true);
	expect(body).toContain("native_hook_stdin_parse_error");
}, 30_000);

it("still allows a stderr hook error when the session id is absent", async () => {
	const root = await tempDir();
	const result = await runMalformed(root, undefined);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toContain("malformed JSON");
	expect(result.stderr).toContain("native_hook_stdin_parse_error");
	expect(fsSync.existsSync(path.join(root, ".gjc"))).toBe(false);
}, 30_000);

it("still allows a traversal-like session id to stay inside the workspace", async () => {
	const root = await tempDir();
	const sessionId = "../../escape";
	const result = await runMalformed(root, sessionId);
	expect(result.exitCode, result.stderr).toBe(0);
	const file = logFile(root, sessionId);
	expect(file.startsWith(`${root}${path.sep}`)).toBe(true);
	expect(await fs.readFile(file, "utf8")).toContain("native_hook_stdin_parse_error");
	expect(fsSync.existsSync(path.join(path.dirname(root), "escape"))).toBe(false);
}, 30_000);

it("still allows a session id with a backslash to stay one path segment", async () => {
	const root = await tempDir();
	const sessionId = "a\\b";
	const result = await runMalformed(root, sessionId);
	expect(result.exitCode, result.stderr).toBe(0);
	const file = logFile(root, sessionId);
	expect(file.includes(`${path.sep}b${path.sep}`)).toBe(false);
	expect(await fs.readFile(file, "utf8")).toContain("native_hook_stdin_parse_error");
}, 30_000);

it("still allows a native hook log when the workspace path has dot segments", async () => {
	const parent = await tempDir();
	const real = path.join(parent, "workspace");
	await fs.mkdir(path.join(parent, "alias"));
	await fs.mkdir(real);
	const cwd = path.join(parent, "alias", "..", "workspace");
	const result = await runMalformed(cwd, "dot-session");
	expect(result.exitCode, result.stderr).toBe(0);
	expect(await fs.readFile(logFile(real, "dot-session"), "utf8")).toContain("native_hook_stdin_parse_error");
}, 30_000);

it.skipIf(!canSymlink)(
	"still allows a native hook log when the workspace path is a symlink",
	async () => {
		const parent = await tempDir();
		const real = path.join(parent, "workspace");
		const link = path.join(parent, "link");
		await fs.mkdir(real);
		fsSync.symlinkSync(real, link);
		const result = await runMalformed(link, "link-session");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(await fs.readFile(logFile(real, "link-session"), "utf8")).toContain("native_hook_stdin_parse_error");
	},
	30_000,
);

it("still keeps the workspace and home directory modes", async () => {
	const root = await tempDir();
	const workspaceBefore = fsSync.statSync(root).mode;
	const homeBefore = fsSync.statSync(os.homedir()).mode;
	const result = await runMalformed(root, "mode-session");
	expect(result.exitCode, result.stderr).toBe(0);
	expect(await fs.readFile(logFile(root, "mode-session"), "utf8")).toContain("native_hook_stdin_parse_error");
	expect(fsSync.statSync(root).mode).toBe(workspaceBefore);
	expect(fsSync.statSync(os.homedir()).mode).toBe(homeBefore);
}, 30_000);

it.skipIf(process.platform === "win32")(
	"still keeps an existing .gjc directory mode",
	async () => {
		const root = await tempDir();
		const gjc = path.join(root, ".gjc");
		await fs.mkdir(gjc);
		await fs.chmod(gjc, 0o755);
		const result = await runMalformed(root, "shared-gjc");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(posixMode(gjc)).toBe(0o755);
		expect(await fs.readFile(logFile(root, "shared-gjc"), "utf8")).toContain("native_hook_stdin_parse_error");
	},
	30_000,
);

it("still allows two native hook log lines from concurrent hooks", async () => {
	const root = await tempDir();
	const [left, right] = await Promise.all([
		runMalformed(root, "concurrent-session"),
		runMalformed(root, "concurrent-session"),
	]);
	expect(left.exitCode, left.stderr).toBe(0);
	expect(right.exitCode, right.stderr).toBe(0);
	const lines = (await fs.readFile(logFile(root, "concurrent-session"), "utf8")).trim().split("\n");
	expect(lines).toHaveLength(2);
	expect(lines.every(line => line.includes("native_hook_stdin_parse_error"))).toBe(true);
}, 30_000);

it.skipIf(process.platform === "win32")(
	"creates a native hook log as owner-only",
	async () => {
		const previous = process.umask(0o022);
		try {
			const root = await tempDir();
			const result = await runMalformed(root, "owner-session");
			expect(result.exitCode, result.stderr).toBe(0);
			const file = logFile(root, "owner-session");
			expect(await fs.readFile(file, "utf8")).toContain("native_hook_stdin_parse_error");
			expect(posixMode(file)).toBe(0o600);
			expect(posixMode(path.dirname(file))).toBe(0o700);
			expect(posixMode(path.dirname(path.dirname(file)))).toBe(0o700);
			expect(posixMode(path.join(root, ".gjc"))).toBe(0o700);
		} finally {
			process.umask(previous);
		}
	},
	30_000,
);

it.skipIf(process.platform === "win32")(
	"tightens an existing native hook log to owner-only",
	async () => {
		const root = await tempDir();
		const file = logFile(root, "tighten-session");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "PRE-EXISTING\n");
		await fs.chmod(file, 0o666);
		const result = await runMalformed(root, "tighten-session");
		expect(result.exitCode, result.stderr).toBe(0);
		const body = await fs.readFile(file, "utf8");
		expect(body.startsWith("PRE-EXISTING\n")).toBe(true);
		expect(body).toContain("native_hook_stdin_parse_error");
		expect(posixMode(file)).toBe(0o600);
	},
	30_000,
);

it.skipIf(!canSymlink)(
	"refuses a symlinked native hook log",
	async () => {
		const root = await tempDir();
		const outside = await tempDir();
		const victim = path.join(outside, "victim.txt");
		await fs.writeFile(victim, "ORIGINAL\n");
		const file = logFile(root, "symlink-file");
		await fs.mkdir(path.dirname(file), { recursive: true });
		fsSync.symlinkSync(victim, file);
		const result = await runMalformed(root, "symlink-file");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("malformed JSON");
		expect(await fs.readFile(victim, "utf8")).toBe("ORIGINAL\n");
	},
	30_000,
);

it.skipIf(!canSymlink)(
	"refuses a symlinked .gjc directory for native hook logs",
	async () => {
		const root = await tempDir();
		const outside = await tempDir();
		fsSync.symlinkSync(outside, path.join(root, ".gjc"));
		const result = await runMalformed(root, "symlink-gjc");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("malformed JSON");
		expect(await fs.readdir(outside)).toEqual([]);
	},
	30_000,
);

it.skipIf(!canSymlink)(
	"refuses a symlinked native hook logs directory",
	async () => {
		const root = await tempDir();
		const outside = await tempDir();
		const sessionId = "symlink-logs";
		const logs = path.dirname(logFile(root, sessionId));
		await fs.mkdir(path.dirname(logs), { recursive: true });
		fsSync.symlinkSync(outside, logs);
		const result = await runMalformed(root, sessionId);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("malformed JSON");
		expect(await fs.readdir(outside)).toEqual([]);
	},
	30_000,
);

it.skipIf(process.platform === "win32")(
	"refuses a fifo native hook log",
	async () => {
		const root = await tempDir();
		const sessionId = "fifo-session";
		const file = logFile(root, sessionId);
		await fs.mkdir(path.dirname(file), { recursive: true });
		const made = Bun.spawnSync(["mkfifo", file]);
		expect(made.exitCode).toBe(0);
		const fd = fsSync.openSync(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
		try {
			const result = await runMalformed(root, sessionId);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toContain("malformed JSON");
			const buf = Buffer.alloc(256);
			let n = 0;
			try {
				n = fsSync.readSync(fd, buf, 0, buf.length, null);
			} catch (error) {
				const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : "";
				if (code !== "EAGAIN") throw error;
			}
			expect(n).toBe(0);
		} finally {
			fsSync.closeSync(fd);
		}
	},
	30_000,
);
