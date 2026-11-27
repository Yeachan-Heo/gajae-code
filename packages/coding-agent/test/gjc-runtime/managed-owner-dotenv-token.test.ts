import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Only a launcher or the managed-owner supervisor sets the child token, together
 * with the owner context it validates and the child inherits. A repository dotenv
 * that names the token alone is configuration, not a launch: an ordinary CLI must
 * run normally there. Any owner context beside the token keeps the full admission
 * path and its fail-closed refusal, because equality with a dotenv value does not
 * prove where a token came from.
 */

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const mainModule = path.join(repoRoot, "packages", "coding-agent", "src", "main.ts");
const envModule = path.join(repoRoot, "packages", "utils", "src", "env.ts");
const admissionModule = path.join(
	repoRoot,
	"packages",
	"coding-agent",
	"src",
	"gjc-runtime",
	"managed-owner-admission.ts",
);
const TOKEN = "GJC_MANAGED_OWNER_CHILD_TOKEN";
const BLOCKED = "managed_owner_admission_blocked";
/** Owner context a supervised child always inherits beside its token. */
const OWNER_CONTEXT_NAMES = [
	"GJC_TMUX_OWNER_STATE_DIR",
	"GJC_COORDINATOR_SESSION_ID",
	"GJC_TMUX_OWNER_GENERATION",
	"GJC_MANAGED_OWNER_RUN_ID",
	"GJC_MANAGED_OWNER_INCARNATION",
	"GJC_MANAGED_OWNER_LAUNCH_BASELINE",
	"GJC_MANAGED_OWNER_TRANSCRIPT_PATH",
	"GJC_MANAGED_OWNER_REDACT_COMMAND",
	"GJC_TMUX_OWNER_SERVER_KEY",
	"GJC_TMUX_LAUNCHED",
	"GJC_MANAGED_OWNER_PREDECESSOR_TOKEN",
	"GJC_MANAGED_OWNER_PREDECESSOR_GENERATION",
	"GJC_MANAGED_OWNER_PREDECESSOR_RUN_ID",
	"GJC_MANAGED_OWNER_PREDECESSOR_INCARNATION",
] as const;

const tempDirs: string[] = [];

function tempDir(files: Record<string, string> = {}): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-owner-dotenv-"));
	tempDirs.push(dir);
	for (const [name, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), body);
	}
	return dir;
}

/**
 * Waits until `readyFile` exists, then gives the process `graceMs` to exit. A process
 * still running then is reported as blocked. Readiness is written just before the
 * call under test, so import and scheduling time never count against the deadline.
 */
async function exitsAfterReady(
	exited: Promise<number>,
	readyFile: string,
	graceMs = 3_000,
	readyTimeoutMs = 15_000,
): Promise<{ ready: boolean; blocked: boolean }> {
	let done = false;
	void exited.then(() => {
		done = true;
	});
	const readyBy = Date.now() + readyTimeoutMs;
	while (!fs.existsSync(readyFile) && !done && Date.now() < readyBy) await Bun.sleep(20);
	if (!fs.existsSync(readyFile)) return { ready: false, blocked: !done };
	const timeout = Bun.sleep(graceMs).then(() => "timeout" as const);
	return { ready: true, blocked: (await Promise.race([exited, timeout])) === "timeout" };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The test process environment without any launcher, owner or tmux context. */
function cleanEnvironment(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value === undefined || name.startsWith("GJC_") || name.startsWith("TMUX")) continue;
		env[name] = value;
	}
	delete env.NODE_ENV;
	delete env.BUN_ENV;
	const home = tempDir();
	env.HOME = home;
	env.USERPROFILE = home;
	env.GJC_CODING_AGENT_DIR = tempDir();
	return { ...env, ...extra };
}

interface Run {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function run(cmd: string[], cwd: string, env: Record<string, string>): Promise<Run> {
	const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

function runCli(cwd: string, args: string[], options: { autoload?: boolean; env?: Record<string, string> } = {}) {
	const bunArgs = options.autoload === false ? ["--no-env-file"] : [];
	return run([process.execPath, ...bunArgs, cliEntry, ...args], cwd, cleanEnvironment(options.env));
}

describe.skipIf(process.platform === "win32")("project dotenv managed-owner child token", () => {
	it.each([
		["Bun dotenv autoload", true],
		["no dotenv autoload", false],
	] as const)("runs the source CLI normally when .env names only the token (%s)", async (_label, autoload) => {
		const cwd = tempDir({ ".env": `${TOKEN}=abc\n` });
		for (const args of [["--version"], ["--help"]]) {
			const result = await runCli(cwd, args, { autoload });
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout.trim()).not.toBe("");
			expect(result.stderr).not.toContain(BLOCKED);
		}
		// Fresh admission never writes managed-owner evidence into the project.
		expect(fs.readdirSync(cwd)).toEqual([".env"]);
	});

	it.each([
		[".env.local", `${TOKEN}=abc\n`, {}],
		[".env.development", `${TOKEN}=abc\n`, {}],
		[".env", `${TOKEN}="abc"\n`, {}],
		[".env", `# owner\n${TOKEN}=abc # local note\n`, {}],
		[".env", `${TOKEN}=abc\r\n`, {}],
		[".env", `${TOKEN}=\n`, {}],
		[".env.test", `${TOKEN}=abc\n`, { NODE_ENV: "test" }],
	] as [
		string,
		string,
		Record<string, string>,
	][])("treats a static token from %s (%j) as project configuration", async (file, body, env) => {
		const result = await runCli(tempDir({ [file]: body }), ["--version"], { env });
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stderr).not.toContain(BLOCKED);
	});

	it.each([
		["a dynamic declaration", `SEED=abc\n${TOKEN}=$SEED\n`, {}],
		["an owner companion beside it", `${TOKEN}=abc\nGJC_MANAGED_OWNER_RUN_ID=run-1\n`, {}],
		["a predecessor key beside it", `${TOKEN}=abc\nGJC_MANAGED_OWNER_PREDECESSOR_TOKEN=old\n`, {}],
		["an inherited token that differs", `${TOKEN}=abc\n`, { [TOKEN]: "def" }],
		["an inherited token equal to a dynamic declaration's text", `SEED=x\n${TOKEN}=$SEED\n`, { [TOKEN]: "$SEED" }],
		["an inherited token with padding", `${TOKEN}=abc\n`, { [TOKEN]: " abc" }],
	] as const)("keeps the fail-closed admission refusal for %s", async (_label, body, env) => {
		const result = await runCli(tempDir({ ".env": body }), ["--version"], { env });
		expect(result.exitCode).toBe(75);
		expect(result.stderr).toContain(BLOCKED);
	});

	it.each([...OWNER_CONTEXT_NAMES])("keeps the refusal when %s is inherited, even empty", async (name: string) => {
		const cwd = tempDir({ ".env": `${TOKEN}=abc\n` });
		for (const value of ["x", ""]) {
			const result = await runCli(cwd, ["--version"], { env: { [name]: value } });
			expect([value, result.exitCode]).toEqual([value, 75]);
			expect(result.stderr).toContain(BLOCKED);
		}
	});

	it("refuses instead of blocking when a project dotenv layer is a FIFO", async () => {
		// Several startup modules already read project dotenv layers unbounded at import,
		// so the FIFO appears after the import, as it could for a running process.
		const cwd = tempDir();
		const fifo = path.join(cwd, ".env");
		const ready = path.join(tempDir(), "ready");
		const probe = `import { writeFileSync } from "node:fs";
import { admitManagedOwnerBeforeCli } from ${JSON.stringify(admissionModule)};
if (Bun.spawnSync(["mkfifo", ${JSON.stringify(fifo)}]).exitCode !== 0) process.exit(19);
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
const admission = await admitManagedOwnerBeforeCli();
process.stdout.write(JSON.stringify({ kind: admission.kind, exitCode: process.exitCode ?? 0 }));
process.exitCode = 0;`;
		const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", probe], {
			cwd,
			env: cleanEnvironment({ [TOKEN]: "abc" }),
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new Response(proc.stdout).text();
		const stderr = new Response(proc.stderr).text();
		try {
			const outcome = await exitsAfterReady(proc.exited, ready);
			// A blocked open of a FIFO is interruptible, so this always ends the probe.
			if (outcome.blocked) proc.kill("SIGKILL");
			expect(outcome).toEqual({ ready: true, blocked: false });
			expect(await proc.exited, await stderr).toBe(0);
			expect(JSON.parse(await stdout)).toEqual({ kind: "blocked", exitCode: 75 });
			expect(await stderr).toContain(BLOCKED);
		} finally {
			proc.kill("SIGKILL");
			await proc.exited;
		}
	}, 25_000);

	it("refuses when a later project layer is too large to read", async () => {
		const cwd = tempDir({
			".env": `${TOKEN}=abc\n`,
			".env.local": `${TOKEN}=def\n# ${"x".repeat(64 * 1024)}\n`,
		});
		const result = await runCli(cwd, ["--version"], { autoload: false, env: { [TOKEN]: "abc" } });
		expect(result.exitCode).toBe(75);
		expect(result.stderr).toContain(BLOCKED);
	});

	// A privileged user reads a 000 file, so the layer would not be unreadable there.
	it.skipIf(process.getuid?.() === 0)("refuses when a later project layer cannot be read", async () => {
		// Readable, the same declaration in both layers is a project-only token.
		const readable = tempDir({ ".env": `${TOKEN}=abc\n`, ".env.local": `${TOKEN}=abc\n` });
		expect((await runCli(readable, ["--version"], { autoload: false, env: { [TOKEN]: "abc" } })).exitCode).toBe(0);
		const cwd = tempDir({ ".env": `${TOKEN}=abc\n`, ".env.local": `${TOKEN}=abc\n` });
		fs.chmodSync(path.join(cwd, ".env.local"), 0o000);
		expect(() => fs.readFileSync(path.join(cwd, ".env.local"))).toThrow();
		const result = await runCli(cwd, ["--version"], { autoload: false, env: { [TOKEN]: "abc" } });
		expect(result.exitCode).toBe(75);
		expect(result.stderr).toContain(BLOCKED);
	});

	it("keeps the refusal for an inherited token when no project declares it", async () => {
		const result = await runCli(tempDir(), ["--version"], { env: { [TOKEN]: "abc" } });
		expect(result.exitCode).toBe(75);
		expect(result.stderr).toContain(BLOCKED);
	});

	it("drops the project token before the exported main() and later gates read it", async () => {
		const cwd = tempDir({ ".env": `${TOKEN}=abc\n` });
		const probe = `import { main } from ${JSON.stringify(mainModule)};
const writes = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => { writes.push(String(chunk)); return true; };
await main(["--version"]);
process.stdout.write = write;
process.stdout.write(JSON.stringify({ exitCode: process.exitCode ?? 0, token: process.env.${TOKEN} ?? null, printed: writes.join("").trim().length > 0 }));`;
		const result = await run([process.execPath, "-e", probe], cwd, cleanEnvironment());
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stderr).not.toContain(BLOCKED);
		expect(JSON.parse(result.stdout)).toEqual({ exitCode: 0, token: null, printed: true });
	});
});

const LAUNCHER_ONLY_NAMES = [
	"GJC_MANAGED_OWNER_CHILD_TOKEN",
	"GJC_MANAGED_OWNER_RUN_ID",
	"GJC_MANAGED_OWNER_INCARNATION",
	"GJC_MANAGED_OWNER_LAUNCH_BASELINE",
	"GJC_MANAGED_OWNER_REDACT_COMMAND",
	"GJC_MANAGED_OWNER_PREDECESSOR_TOKEN",
	"GJC_MANAGED_OWNER_PREDECESSOR_GENERATION",
	"GJC_MANAGED_OWNER_PREDECESSOR_RUN_ID",
	"GJC_MANAGED_OWNER_PREDECESSOR_INCARNATION",
	"GJC_MANAGED_OWNER_TRANSCRIPT_PATH",
	"GJC_TMUX_OWNER_STATE_DIR",
	"GJC_TMUX_OWNER_GENERATION",
	"GJC_TMUX_OWNER_SERVER_KEY",
	"GJC_TMUX_LAUNCHED",
] as const;
const CONTROL = "GJC_P3_DOTENV_CONTROL";

/** Loads the env module without Bun autoload, so only its own file copy applies. */
async function envAfterCopy(
	layer: "project" | "agent" | "config" | "home" | "shell",
	inherited: Record<string, string> = {},
): Promise<Record<string, string | null>> {
	const names = [...LAUNCHER_ONLY_NAMES, CONTROL];
	const dotenv = `${names.map(name => `${name}=from-file`).join("\n")}\n`;
	const env = cleanEnvironment(inherited);
	const cwd = tempDir(layer === "project" ? { ".env": dotenv } : {});
	if (layer === "agent") fs.writeFileSync(path.join(env.GJC_CODING_AGENT_DIR!, ".env"), dotenv);
	if (layer === "config") {
		fs.mkdirSync(path.join(env.HOME!, ".gjc"), { recursive: true });
		fs.writeFileSync(path.join(env.HOME!, ".gjc", ".env"), dotenv);
	}
	if (layer === "home") fs.writeFileSync(path.join(env.HOME!, ".env"), dotenv);
	if (layer === "shell") {
		fs.writeFileSync(path.join(env.HOME!, ".zshrc"), names.map(name => `export ${name}=from-file`).join("\n"));
	}
	const probe = `await import(${JSON.stringify(envModule)});
const names = ${JSON.stringify(names)};
process.stdout.write(JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name] ?? null]))));`;
	const result = await run([process.execPath, "--no-env-file", "-e", probe], cwd, env);
	if (result.exitCode !== 0) throw new Error(`probe failed (${result.exitCode}): ${result.stderr}`);
	return JSON.parse(result.stdout) as Record<string, string | null>;
}

describe.skipIf(process.platform === "win32")("env module file copy of launcher-only names", () => {
	it.each([
		"project",
		"agent",
		"config",
		"home",
		"shell",
	] as const)("never installs them from the %s layer", async layer => {
		const observed = await envAfterCopy(layer);
		// The layer was read: an ordinary name is copied.
		expect(observed[CONTROL]).toBe("from-file");
		for (const name of LAUNCHER_ONLY_NAMES) expect([name, observed[name]]).toEqual([name, null]);
	});

	it.each(["empty", "set"] as const)("keeps %s inherited values untouched", async kind => {
		const inherited = Object.fromEntries(LAUNCHER_ONLY_NAMES.map(name => [name, kind === "empty" ? "" : name]));
		const observed = await envAfterCopy("project", inherited);
		expect(observed[CONTROL]).toBe("from-file");
		for (const name of LAUNCHER_ONLY_NAMES) expect([name, observed[name]]).toEqual([name, inherited[name]]);
	});
});
