#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_TEST_TIMEOUT_MS = 30_000;
export const DEFAULT_FILE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_CONCURRENCY = 1;
export const TEST_PRELOAD = "./scripts/test-preload.ts";

export interface HarnessOptions {
	root: string;
	shard?: { index: number; total: number };
	testTimeoutMs: number;
	fileTimeoutMs: number;
	concurrency: number;
}

export interface TestProcessSpec {
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	file: string;
	sandbox: string;
}

export interface TestProcessResult {
	exitCode: number;
	signal?: NodeJS.Signals;
	timedOut: boolean;
}

export type TestProcessRunner = (spec: TestProcessSpec, timeoutMs: number) => Promise<TestProcessResult>;

export interface LinuxProcessIdentity {
	pid: number;
	processGroup: number;
	startTime: string;
	state: string;
}

const repoRoot = path.join(import.meta.dir, "..");
const TEST_FILE_PATTERN = /(?:^|\/)(?:[^/]+\.(?:test|spec)|(?:test|spec)_[^/]+)\.(?:[cm]?[jt]sx?)$/u;
const PROVIDER_ENDPOINT_ENV = [
	"ANTHROPIC_BASE_URL",
	"E2E",
	"GJC_E2E_GATEWAY_URL",
	"OPENAI_BASE_URL",
] as const;
const INHERITED_GJC_STATE_ENV = [
	"GJC_AGENT_DIR",
	"GJC_CODING_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
	"GJC_SESSION_ID",
	"GJC_STATE_SESSION_ID",
	"GJC_STATE_ROOT",
	"GJC_LIFECYCLE_REQUEST_ID",
	"GJC_SDK_LIFECYCLE_REQUEST",
] as const;
const CREDENTIAL_ENV_SUFFIXES = ["_API_KEY", "_AUTH_TOKEN", "_OAUTH_TOKEN", "_ACCESS_TOKEN"] as const;
const CREDENTIAL_ENV_NAMES = new Set([
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
]);

function isCredentialEnvironmentName(name: string): boolean {
	return CREDENTIAL_ENV_NAMES.has(name) || CREDENTIAL_ENV_SUFFIXES.some(suffix => name.endsWith(suffix));
}

// This committed evidence oracle hashes its owning provider source. It is
// scheduled directly when the evidence artifact changes; unrelated provider
// edits intentionally make the committed blob stale until that owner regenerates
// it, so package-wide runtime suites must not execute it implicitly.
const SOURCE_BOUND_EVIDENCE_TESTS = new Set(["packages/ai/test/anthropic-cache-eval.integration.test.ts"]);

function usage(message?: string): never {
	if (message) process.stderr.write(`${message}\n`);
	process.stderr.write(
		"Usage: bun scripts/run-bun-test-files.ts --root=<directory> [--shard=<index>/<total>] [--timeout=<ms>] [--file-timeout=<ms>] [--concurrency=<count>]\n",
	);
	process.exit(2);
}

function positiveInteger(value: string | undefined, flag: string, fallback?: number): number {
	if (value === undefined && fallback !== undefined) return fallback;
	if (!value || !/^[1-9]\d*$/u.test(value)) usage(`${flag} must be a positive integer.`);
	return Number(value);
}

export function parseHarnessOptions(argv: readonly string[]): HarnessOptions {
	const values = new Map<string, string>();
	for (const argument of argv) {
		const match = argument.match(/^--([^=]+)=(.*)$/u);
		if (!match) usage(`Unknown argument: ${argument}`);
		const [, name, value] = match;
		if (!name || value === undefined || !["root", "shard", "timeout", "file-timeout", "concurrency"].includes(name))
			usage(`Unknown argument: ${argument}`);
		if (values.has(name)) usage(`Duplicate argument: --${name}`);
		values.set(name, value);
	}
	const root = values.get("root")?.trim();
	if (!root) usage("--root is required.");
	const shardValue = values.get("shard");
	let shard: HarnessOptions["shard"];
	if (shardValue !== undefined) {
		const match = shardValue.match(/^([1-9]\d*)\/([1-9]\d*)$/u);
		if (!match) usage("--shard must use <index>/<total>.");
		const index = Number(match[1]);
		const total = Number(match[2]);
		if (index > total) usage("--shard index cannot exceed its total.");
		shard = { index, total };
	}
	return {
		root,
		shard,
		testTimeoutMs: positiveInteger(values.get("timeout"), "--timeout", DEFAULT_TEST_TIMEOUT_MS),
		fileTimeoutMs: positiveInteger(values.get("file-timeout"), "--file-timeout", DEFAULT_FILE_TIMEOUT_MS),
		concurrency: positiveInteger(values.get("concurrency"), "--concurrency", DEFAULT_CONCURRENCY),
	};
}

export async function enumerateTestFiles(root: string, base: string = repoRoot): Promise<string[]> {
	const absoluteRoot = path.resolve(base, root);
	const relativeRoot = path.relative(base, absoluteRoot);
	if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) throw new Error(`Test root escapes repository: ${root}`);
	const files: string[] = [];
	for await (const entry of new Bun.Glob("**/*").scan({ cwd: absoluteRoot, onlyFiles: true, dot: true })) {
		const normalized = entry.split(path.sep).join("/");
		if (!TEST_FILE_PATTERN.test(normalized)) continue;
		const file = path.posix.join(relativeRoot.split(path.sep).join("/"), normalized);
		if (SOURCE_BOUND_EVIDENCE_TESTS.has(file)) continue;
		files.push(file);
	}
	return files.sort();
}

export function selectShard(files: readonly string[], shard?: HarnessOptions["shard"]): string[] {
	if (!shard) return [...files];
	return files.filter((_, index) => index % shard.total === shard.index - 1);
}

export function buildTestProcessSpec(
	file: string,
	sandbox: string,
	testTimeoutMs: number,
	base: string = repoRoot,
	parentEnv: NodeJS.ProcessEnv = process.env,
): TestProcessSpec {
	const home = path.join(sandbox, "home");
	const env: NodeJS.ProcessEnv = { ...parentEnv };
	const e2eEnabled = /^(1|true|yes|on)$/iu.test(parentEnv.E2E?.trim() ?? "");
	if (!e2eEnabled) {
		for (const name of PROVIDER_ENDPOINT_ENV) env[name] = undefined;
		for (const name of Object.keys(env)) {
			if (isCredentialEnvironmentName(name)) env[name] = undefined;
		}
	}
	for (const name of INHERITED_GJC_STATE_ENV) env[name] = undefined;
	return {
		argv: ["bun", "test", `--timeout=${testTimeoutMs}`, "--preload", TEST_PRELOAD, `./${file}`],
		cwd: base,
		file,
		sandbox,
		env: {
			...env,
			HOME: home,
			USERPROFILE: home,
			XDG_CONFIG_HOME: path.join(sandbox, "xdg", "config"),
			XDG_DATA_HOME: path.join(sandbox, "xdg", "data"),
			XDG_STATE_HOME: path.join(sandbox, "xdg", "state"),
			XDG_CACHE_HOME: path.join(sandbox, "xdg", "cache"),
			XDG_RUNTIME_DIR: path.join(sandbox, "xdg", "runtime"),
			TMPDIR: path.join(sandbox, "tmp"),
			TMP: path.join(sandbox, "tmp"),
			TEMP: path.join(sandbox, "tmp"),
			GJC_HOME: path.join(sandbox, "gjc-home"),
			GJC_CONFIG_DIR: ".gjc",
		},
	};
}

export async function probeLinuxProcess(pid: number): Promise<LinuxProcessIdentity | undefined> {
	try {
		const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const state = fields[0];
		const processGroup = Number(fields[2]);
		const startTime = fields[19];
		if (!state || !Number.isSafeInteger(processGroup) || !startTime) throw new Error(`Malformed /proc/${pid}/stat.`);
		return { pid, processGroup, startTime, state };
	} catch (error) {
		if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
}

function probeLinuxProcessSync(pid: number): LinuxProcessIdentity | undefined {
	try {
		const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const state = fields[0];
		const processGroup = Number(fields[2]);
		const startTime = fields[19];
		if (!state || !Number.isSafeInteger(processGroup) || !startTime) throw new Error(`Malformed /proc/${pid}/stat.`);
		return { pid, processGroup, startTime, state };
	} catch (error) {
		if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
}

export async function processIdentityIsExecuting(identity: LinuxProcessIdentity): Promise<boolean> {
	const current = await probeLinuxProcess(identity.pid);
	if (!current || current.startTime !== identity.startTime) return false;
	return current.state !== "Z" && current.state !== "X";
}

async function processGroupHasExecutingMembers(processGroup: number): Promise<boolean> {
	if (process.platform !== "linux") {
		try {
			process.kill(-processGroup, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}
	for (const entry of await fs.readdir("/proc")) {
		if (!/^\d+$/u.test(entry)) continue;
		let identity: LinuxProcessIdentity | undefined;
		try {
			identity = await probeLinuxProcess(Number(entry));
		} catch {
			return true;
		}
		if (identity?.processGroup === processGroup && identity.state !== "Z" && identity.state !== "X") return true;
	}
	return false;
}

async function waitForNoExecutingGroupMembers(processGroup: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	do {
		if (!(await processGroupHasExecutingMembers(processGroup))) return true;
		await Bun.sleep(20);
	} while (Date.now() < deadline);
	return !(await processGroupHasExecutingMembers(processGroup));
}

async function signalProcessGroup(child: Bun.Subprocess, signal: NodeJS.Signals): Promise<void> {
	if (process.platform === "win32") {
		if (child.exitCode !== null) return;
		child.kill(signal);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function terminateProcess(child: Bun.Subprocess, leader: LinuxProcessIdentity | undefined): Promise<void> {
	if (process.platform === "win32") {
		await signalProcessGroup(child, "SIGTERM");
		await Bun.sleep(1_000);
		await signalProcessGroup(child, "SIGKILL");
		return;
	}
	const currentLeader = await probeLinuxProcess(child.pid);
	if (leader && currentLeader && currentLeader.startTime !== leader.startTime) {
		throw new Error(`Refusing to signal reused process-group leader pid ${child.pid}.`);
	}
	await signalProcessGroup(child, "SIGTERM");
	if (await waitForNoExecutingGroupMembers(child.pid, 1_000)) return;
	const leaderAfterGrace = await probeLinuxProcess(child.pid);
	if (leader && leaderAfterGrace && leaderAfterGrace.startTime !== leader.startTime) {
		throw new Error(`Refusing to SIGKILL reused process-group leader pid ${child.pid}.`);
	}
	await signalProcessGroup(child, "SIGKILL");
	if (!(await waitForNoExecutingGroupMembers(child.pid, 2_000))) {
		throw new Error(`Process group ${child.pid} still has executing members after SIGKILL.`);
	}
}

export const runTestProcess: TestProcessRunner = async (spec, timeoutMs) => {
	const child = Bun.spawn(spec.argv, {
		cwd: spec.cwd,
		env: spec.env,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		detached: process.platform !== "win32",
	});
	// Signal handlers cannot run between these synchronous statements. Capture
	// Linux start identity before publishing the child as active, so every visible
	// entry is identity-bound and a reused pid/process-group is never signalled.
	const leader = process.platform === "linux" ? probeLinuxProcessSync(child.pid) : undefined;
	activeChildren.set(child, leader);
	let timedOut = false;
	let timeoutCleanup: Promise<void> | undefined;
	const { promise: timeoutStarted, resolve: resolveTimeoutStarted } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		timedOut = true;
		timeoutCleanup = terminateProcess(child, leader);
		resolveTimeoutStarted();
	}, timeoutMs);
	try {
		const first = await Promise.race([child.exited.then(exitCode => ({ exitCode })), timeoutStarted.then(() => undefined)]);
		let exitCode: number;
		if (first) exitCode = first.exitCode;
		else {
			await timeoutCleanup;
			exitCode = await child.exited;
		}
		if (process.platform !== "win32" && (await processGroupHasExecutingMembers(child.pid))) {
			await terminateProcess(child, leader);
		}
		return { exitCode, signal: child.signalCode ?? undefined, timedOut };
	} finally {
		clearTimeout(timer);
		activeChildren.delete(child);
	}
};

const activeChildren = new Map<Bun.Subprocess, LinuxProcessIdentity | undefined>();
let terminating = false;
let signalHandlersInstalled = false;

async function handleSignal(signal: NodeJS.Signals): Promise<void> {
	if (terminating) return;
	terminating = true;
	const children = Array.from(activeChildren);
	await Promise.all(children.map(([child, leader]) => terminateProcess(child, leader)));
	process.exit(signal === "SIGINT" ? 130 : 143);
}

export function installSignalHandlers(): void {
	if (signalHandlersInstalled) return;
	signalHandlersInstalled = true;
	process.once("SIGINT", () => void handleSignal("SIGINT"));
	process.once("SIGTERM", () => void handleSignal("SIGTERM"));
}

export async function runHarness(
	options: HarnessOptions,
	runner: TestProcessRunner = runTestProcess,
	base: string = repoRoot,
): Promise<number> {
	const allFiles = await enumerateTestFiles(options.root, base);
	const files = selectShard(allFiles, options.shard);
	if (allFiles.length === 0) throw new Error(`No test files found under ${options.root}.`);
	if (files.length === 0) throw new Error(`Shard contains no test files under ${options.root}.`);
	process.stdout.write(
		`fresh-process test harness: root=${options.root} files=${files.length}/${allFiles.length}${options.shard ? ` shard=${options.shard.index}/${options.shard.total}` : ""}\n`,
	);
	const outcomes = new Array<TestProcessResult | undefined>(files.length);
	let claimed = 0;
	const executeFiles = async (): Promise<void> => {
		for (;;) {
			const index = claimed++;
			const file = files[index];
			if (!file) return;
			const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-test-file-"));
			const spec = buildTestProcessSpec(file, sandbox, options.testTimeoutMs, base);
			await Promise.all([
				fs.mkdir(spec.env.HOME!, { recursive: true }),
				fs.mkdir(spec.env.XDG_CONFIG_HOME!, { recursive: true }),
				fs.mkdir(spec.env.XDG_DATA_HOME!, { recursive: true }),
				fs.mkdir(spec.env.XDG_STATE_HOME!, { recursive: true }),
				fs.mkdir(spec.env.XDG_CACHE_HOME!, { recursive: true }),
				fs.mkdir(spec.env.XDG_RUNTIME_DIR!, { recursive: true, mode: 0o700 }),
				fs.mkdir(spec.env.TMPDIR!, { recursive: true }),
				fs.mkdir(spec.env.GJC_HOME!, { recursive: true }),
			]);
			process.stdout.write(`\n[${index + 1}/${files.length}] START ${file}\n`);
			let result: TestProcessResult;
			try {
				result = await runner(spec, options.fileTimeoutMs);
			} catch (error) {
				process.stderr.write(`${file}: harness runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
				result = { exitCode: 1, timedOut: false };
			} finally {
				await fs.rm(sandbox, { recursive: true, force: true });
				process.stdout.write(`[${index + 1}/${files.length}] END ${file}\n`);
			}
			outcomes[index] = result;
		}
	};
	await Promise.all(Array.from({ length: Math.min(options.concurrency, files.length) }, executeFiles));
	const failures = files.flatMap((file, index) => {
		const result = outcomes[index];
		return result && (result.exitCode !== 0 || result.timedOut || result.signal) ? [{ file, result }] : [];
	});
	if (failures.length === 0) {
		process.stdout.write(`fresh-process test harness passed: ${files.length} files\n`);
		return 0;
	}
	process.stderr.write(`fresh-process test harness failed: ${failures.length}/${files.length} files\n`);
	for (const { file, result } of failures) {
		process.stderr.write(
			` - ${file}: exit=${result.exitCode}${result.signal ? ` signal=${result.signal}` : ""}${result.timedOut ? " timeout" : ""}\n`,
		);
	}
	return 1;
}

if (import.meta.main) {
	try {
		installSignalHandlers();
		process.exitCode = await runHarness(parseHarnessOptions(process.argv.slice(2)));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
