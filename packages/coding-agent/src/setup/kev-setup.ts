import { createHash, randomBytes, randomUUID } from "node:crypto";
import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { z } from "zod";
import { acquireFileLock, FileLockAcquireError } from "../config/file-lock";
import {
	CONTROL_FILE,
	controlRequest,
	controlSocketPathIsBindable,
	isConfirmedStop,
	KEV_COMMIT_LINE,
	KEV_SERVICE_SHIM_SOURCE,
	KEV_SUPERVISOR_SOURCE,
	type KevControlReply,
	kevControl,
	SERVICE_SHIM_FILE,
	SUPERVISOR_FILE,
} from "./kev-supervisor";

export type KevSetupAction = "install" | "start" | "stop" | "status";
export const DEFAULT_KEV_MODEL = "jaredpalmer/kev-4b";
export const DEFAULT_KEV_PORT = 8009;
const UPSTREAM = "https://github.com/jaredpalmer/kev.git";
const SERVICE_FILE = "server.json";
const INSTALL_FILE = "install.json";
const pointerSchema = z.object({ root: z.string().min(1) }).strict();
const hubModel = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const installSchema = z
	.object({
		version: z.literal(1),
		upstream: z.literal(UPSTREAM),
		root: z.string().min(1),
		revision: z.string().regex(/^[a-f0-9]{40}$/u),
		model: hubModel,
		snapshot: z.string().min(1),
	})
	.strict();
/**
 * Version 2 records a supervisor, not a bare `kev.serve` process: `pid`/`argv`
 * describe the supervisor and `socket`/`token` are the only authority to stop it.
 * Version-1 records are simply not ours — the feature is unreleased, so they are
 * refused as foreign rather than migrated into a control channel they never had.
 */
const serviceSchema = z
	.object({
		version: z.literal(2),
		pid: z.number().int().min(2),
		ownerId: z.string().uuid(),
		incarnation: z.string().min(1),
		argv: z.array(z.string().min(1)).min(9),
		argvDigest: z.string().regex(/^[a-f0-9]{64}$/u),
		root: z.string().min(1),
		model: hubModel,
		port: z.number().int().min(1).max(65535),
		socket: z.string().min(1),
		token: z.string().regex(/^[a-f0-9]{64}$/u),
	})
	.strict();
type Installation = z.infer<typeof installSchema>;
type ServiceRecord = z.infer<typeof serviceSchema>;
export interface KevProcessIdentity {
	command: string;
	incarnation: string;
}
export interface KevCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}
export interface KevCommandOptions {
	cwd: string;
	env: Record<string, string>;
}
export interface KevSpawnOptions extends KevCommandOptions {
	logPath: string;
	logFd: number;
	/** Control token handed to the supervisor on stdin, never through argv or env. */
	token: string;
}
export interface KevChild {
	pid: number;
	/**
	 * Release the supervisor to start the service. Called only after the ownership
	 * record is durable; until then the supervisor is blocked on stdin, so a caller
	 * that dies leaves nothing running.
	 */
	commit(): void;
	unref(): void;
	kill(): void;
}
export interface KevSetupDeps {
	stateDir?: string;
	run?: (argv: string[], options: KevCommandOptions) => Promise<KevCommandResult>;
	spawn?: (argv: string[], options: KevSpawnOptions) => KevChild;
	inspect?: (pid: number) => KevProcessIdentity | undefined;
	portAvailable?: (port: number) => boolean;
	listens?: (pid: number, port: number) => boolean;
	health?: (port: number) => Promise<boolean>;
	/** The only channel that may stop an owned server; there is deliberately no `kill` dependency. */
	control?: (socketPath: string, message: string) => Promise<KevControlReply | undefined>;
	sleep?: (ms: number) => Promise<void>;
	readyTimeoutMs?: number;
	/** How long a stop waits for the recorded port to go quiet before failing closed. */
	stopTimeoutMs?: number;
}
export interface KevStatus {
	ok: boolean;
	/**
	 * `orphaned` means a service is (or may still be) running that this tool can no
	 * longer prove it owns — installation metadata went missing, or the recorded
	 * port still has a listener after the supervisor is gone. It is never success:
	 * retiring the record here would forget a live server.
	 */
	state: "not-installed" | "stopped" | "starting" | "running" | "stopping" | "stale" | "foreign" | "orphaned";
	root: string;
	model?: string;
	port?: number;
	pid?: number;
	error?: string;
}
export interface KevSetupOptions {
	model?: string;
	root?: string;
	port?: number;
	json?: boolean;
}

async function checkDirectory(dir: string, create = false): Promise<boolean> {
	let stat: nodeFs.Stats;
	try {
		stat = await fs.lstat(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (!create) return false;
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		stat = await fs.lstat(dir);
	}
	if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
		throw new Error("Kev requires a real, user-owned directory");
	}
	return true;
}
async function readPrivate<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
	let stat: nodeFs.Stats;
	try {
		stat = await fs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		(process.getuid && stat.uid !== process.getuid()) ||
		stat.size > 16_384
	) {
		throw new Error("Unsafe Kev ownership metadata");
	}
	return schema.parse(await Bun.file(file).json());
}
async function writePrivateText(file: string, contents: string): Promise<void> {
	const temp = `${file}.${randomUUID()}.tmp`;
	const handle = await fs.open(temp, "wx", 0o600);
	try {
		await Bun.write(Bun.file(handle.fd), contents);
		await handle.sync();
		await handle.close();
		await fs.rename(temp, file);
	} finally {
		await handle.close().catch(() => undefined);
		await fs.rm(temp, { force: true });
	}
}
async function writePrivate(file: string, value: unknown): Promise<void> {
	await writePrivateText(file, `${JSON.stringify(value, null, 2)}\n`);
}
function digest(argv: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify(argv)).digest("hex");
}
function environment(root: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
		HOME: path.join(root, "home"),
		XDG_CONFIG_HOME: path.join(root, "home", ".config"),
		XDG_CACHE_HOME: path.join(root, "cache"),
		XDG_DATA_HOME: path.join(root, "data"),
		UV_PYTHON_INSTALL_DIR: path.join(root, "python"),
		UV_PYTHON_PREFERENCE: "only-managed",
		GIT_TERMINAL_PROMPT: "0",
	};
}
async function runDefault(argv: string[], options: KevCommandOptions): Promise<KevCommandResult> {
	const child = Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}
async function checked(argv: string[], cwd: string, root: string, deps: KevSetupDeps): Promise<string> {
	const result = await (deps.run ?? runDefault)(argv, { cwd, env: environment(root) });
	if (result.exitCode !== 0)
		throw new Error(`Kev ${argv[0]} ${argv[1] ?? ""} failed (${result.exitCode}): ${result.stderr.slice(-2000)}`);
	return result.stdout.trim();
}
function inspectDefault(pid: number): KevProcessIdentity | undefined {
	const result = Bun.spawnSync(["ps", "-ww", "-p", String(pid), "-o", "lstart=,command="], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return undefined;
	const match = new TextDecoder()
		.decode(result.stdout)
		.trim()
		.match(/^(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/u);
	return match ? { incarnation: match[1], command: match[2] } : undefined;
}
function executable(root: string): string {
	return path.join(root, "repo", ".venv", "bin", "python");
}
function controlSocket(root: string): string {
	return path.join(root, CONTROL_FILE);
}
/**
 * The supervised command. `kev.serve` is reached through the shim rather than
 * `-m` so the server process carries the watchdog that ends it if the
 * supervisor dies; runpy keeps it a single process, so this is still the pid
 * that holds the port.
 */
function serviceCommand(root: string, run: string, port: number): string[] {
	return [
		executable(root),
		path.join(root, SERVICE_SHIM_FILE),
		"--",
		"kev.serve",
		"--run",
		run,
		"--fallback",
		run,
		"--port",
		String(port),
	];
}
/**
 * The recorded process is the supervisor; the supervised command follows `--`.
 * Ownership proof therefore covers both the supervised server arguments and the
 * exact control socket it answers on.
 */
function serviceArgv(root: string, run: string, port: number, ownerId: string): string[] {
	return [
		executable(root),
		"-X",
		`gjc_kev_owner=${ownerId}`,
		path.join(root, SUPERVISOR_FILE),
		"--socket",
		controlSocket(root),
		"--port",
		String(port),
		"--",
		...serviceCommand(root, run, port),
	];
}
function owns(record: ServiceRecord, install: Installation, observed: KevProcessIdentity | undefined): boolean {
	const expected = serviceArgv(install.root, install.snapshot, record.port, record.ownerId);
	return (
		record.root === install.root &&
		record.model === install.model &&
		// The socket is authority, not a hint: an otherwise valid record pointing at
		// an attacker-chosen path would send the stop token to a listener of their
		// choosing. Only the socket this installation's supervisor binds is accepted.
		record.socket === controlSocket(install.root) &&
		record.argvDigest === digest(expected) &&
		JSON.stringify(record.argv) === JSON.stringify(expected) &&
		observed?.incarnation === record.incarnation &&
		observed.command === expected.join(" ")
	);
}
function portAvailable(port: number): boolean {
	try {
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port,
			socket: {
				data() {},
				open(socket) {
					socket.end();
				},
			},
		});
		server.stop(true);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
		throw error;
	}
}
function listens(pid: number, port: number): boolean {
	const result = Bun.spawnSync(["lsof", "-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return result.exitCode === 0 && new TextDecoder().decode(result.stdout).split("\n").includes(`n127.0.0.1:${port}`);
}
async function healthy(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
			signal: AbortSignal.timeout(1000),
			redirect: "error",
		});
		void response.body?.cancel().catch(() => undefined);
		return response.ok;
	} catch {
		return false;
	}
}
async function installed(root: string): Promise<Installation | undefined> {
	const metadata = await readPrivate(path.join(root, INSTALL_FILE), installSchema);
	if (metadata && metadata.root !== root) throw new Error("Kev installation root mismatch");
	return metadata;
}
/** A recorded service, or the fact that its metadata is unreadable. Never both. */
async function readService(root: string): Promise<{ record?: ServiceRecord; unsafe: boolean }> {
	try {
		return { record: await readPrivate(path.join(root, SERVICE_FILE), serviceSchema), unsafe: false };
	} catch {
		return { unsafe: true };
	}
}
/** Is anything still listening on the recorded loopback port, whoever owns it now? */
function portHasListener(port: number, deps: KevSetupDeps): boolean {
	return !(deps.portAvailable ?? portAvailable)(port);
}
/** Wait, bounded, for the recorded port to go quiet. False means a listener outlived the stop. */
async function awaitPortRelease(port: number, deps: KevSetupDeps): Promise<boolean> {
	const deadline = Date.now() + (deps.stopTimeoutMs ?? 5_000);
	for (;;) {
		if (!portHasListener(port, deps)) return true;
		if (Date.now() >= deadline) return false;
		await (deps.sleep ?? Bun.sleep)(100);
	}
}
async function status(root: string, deps: KevSetupDeps): Promise<KevStatus> {
	// The service record is read first. A running server must never be reported as
	// `not-installed` just because its installation metadata was removed — that
	// answer reads as "nothing to do" and leaves the server running forever.
	const service = await readService(root);
	if (service.unsafe) return { ok: false, state: "foreign", root, error: "Invalid or unsafe Kev ownership metadata" };
	const record = service.record;
	let install: Installation | undefined;
	try {
		install = await installed(root);
	} catch {
		install = undefined;
	}
	if (!record) {
		if (!install) return { ok: false, state: "not-installed", root };
		return { ok: true, state: "stopped", root, model: install.model };
	}
	if (!install) {
		return {
			ok: false,
			state: "orphaned",
			root,
			model: record.model,
			port: record.port,
			pid: record.pid,
			error: "Kev service record exists without readable installation metadata",
		};
	}
	const observed = (deps.inspect ?? inspectDefault)(record.pid);
	if (!observed) {
		// The supervisor is gone. Only an idle port proves the service went with it.
		if (portHasListener(record.port, deps)) {
			return {
				ok: false,
				state: "orphaned",
				root,
				model: record.model,
				port: record.port,
				pid: record.pid,
				error: "Kev supervisor is gone but its recorded port still has a listener",
			};
		}
		return { ok: true, state: "stale", root, model: record.model, port: record.port, pid: record.pid };
	}
	if (!owns(record, install, observed))
		return { ok: false, state: "foreign", root, error: "Kev process ownership or incarnation does not match" };
	// The supervisor binds the port and passes the listening socket to its child,
	// so both hold it. Ask the authenticated control channel which pid the child
	// is, so `listens` names the process actually serving rather than assuming
	// whoever answers on the loopback port is ours.
	const reported = await (deps.control ?? kevControl)(controlSocket(root), controlRequest("status", record.token));
	const servicePid = reported?.ok && reported.state === "running" ? reported.pid : undefined;
	const ready =
		servicePid !== undefined &&
		(deps.listens ?? listens)(servicePid, record.port) &&
		(await (deps.health ?? healthy)(record.port));
	return {
		ok: true,
		state: ready ? "running" : "starting",
		root,
		model: record.model,
		port: record.port,
		pid: record.pid,
	};
}
async function verifyCheckout(root: string, install: Installation | undefined, deps: KevSetupDeps): Promise<string> {
	const repo = path.join(root, "repo");
	await checkDirectory(repo);
	const origin = await checked(["git", "remote", "get-url", "origin"], repo, root, deps);
	if (origin !== UPSTREAM) throw new Error("Refusing a foreign Kev checkout");
	const revision = await checked(["git", "rev-parse", "HEAD"], repo, root, deps);
	if (!/^[a-f0-9]{40}$/u.test(revision) || (install && revision !== install.revision))
		throw new Error("Kev checkout revision mismatch");
	await checked(["git", "diff", "--quiet", "HEAD", "--"], repo, root, deps);
	return revision;
}
async function installKev(
	root: string,
	stateDir: string,
	options: KevSetupOptions,
	deps: KevSetupDeps,
): Promise<KevStatus> {
	if (!deps.run && (process.platform !== "darwin" || process.arch !== "arm64"))
		throw new Error("This Kev setup supports Apple Silicon macOS");
	let previous: Installation | undefined;
	try {
		previous = await installed(root);
	} catch {
		previous = undefined;
	}
	// Ask before touching anything, and ask whether or not installation metadata
	// loaded. Losing install.json does not stop a service: a record plus a live
	// supervisor is still a running server, and `uv sync` under it would rewrite
	// the environment the server is executing from.
	const current = await status(root, deps);
	if (!["not-installed", "stopped", "stale"].includes(current.state)) {
		throw new Error(
			`Refusing to install over a Kev service that is ${current.state}${current.error ? `: ${current.error}` : ""}. Stop it first with: gjc setup kev stop`,
		);
	}
	const model = hubModel.parse(options.model ?? previous?.model ?? DEFAULT_KEV_MODEL);
	for (const dir of ["home", "cache", "data", "python"]) await checkDirectory(path.join(root, dir), true);
	await checked(["uv", "--version"], root, root, deps);
	await checked(["uv", "python", "install", "3.13"], root, root, deps);
	const repo = path.join(root, "repo");
	if (!(await checkDirectory(repo))) await checked(["git", "clone", UPSTREAM, repo], root, root, deps);
	const revision = await verifyCheckout(root, previous, deps);
	await checked(["uv", "sync", "--python", "3.13", "--extra", "serve"], repo, root, deps);
	await checkDirectory(path.join(repo, ".venv"));
	await checked(
		[executable(root), "-c", "import mlx.core; import sys; assert (3,12) <= sys.version_info[:2] < (3,14)"],
		repo,
		root,
		deps,
	);
	const downloaded = await checked(
		[
			executable(root),
			"-c",
			"import sys; from huggingface_hub import snapshot_download; print(snapshot_download(repo_id=sys.argv[1]))",
			model,
		],
		repo,
		root,
		deps,
	);
	const snapshot = downloaded.split("\n").at(-1) ?? "";
	if (!path.isAbsolute(snapshot) || !(await checkDirectory(snapshot)))
		throw new Error("Kev model download did not produce a local snapshot");
	if (!(await Bun.file(path.join(snapshot, "head.pt")).exists()))
		throw new Error("Kev snapshot has no trained pointer head");
	await writePrivate(path.join(root, INSTALL_FILE), {
		version: 1,
		upstream: UPSTREAM,
		root,
		revision,
		model,
		snapshot,
	});
	await checkDirectory(stateDir, true);
	await writePrivate(path.join(stateDir, "kev-root.json"), { root });
	return { ok: true, state: "stopped", root, model };
}
function spawnDefault(argv: string[], options: KevSpawnOptions): KevChild {
	const child = Bun.spawn(argv, {
		cwd: options.cwd,
		env: options.env,
		detached: true,
		stdin: "pipe",
		stdout: options.logFd,
		stderr: options.logFd,
	});
	// The token travels on stdin only: argv and the environment are readable by
	// any local process, and the log file would persist it on disk. stdin stays
	// open afterwards — it is the commit barrier, and closing it without a commit
	// is exactly how a dead caller tells the supervisor to start nothing.
	child.stdin.write(`${options.token}\n`);
	child.stdin.flush();
	return {
		pid: child.pid,
		commit: () => {
			child.stdin.write(`${KEV_COMMIT_LINE}\n`);
			child.stdin.end();
		},
		unref: () => child.unref(),
		kill: () => {
			child.kill("SIGTERM");
		},
	};
}
async function startKev(root: string, options: KevSetupOptions, deps: KevSetupDeps): Promise<KevStatus> {
	const install = await installed(root);
	if (!install) throw new Error("Kev is not installed; run gjc setup kev install first");
	if (options.model !== undefined && options.model !== install.model)
		throw new Error("Install the requested Kev model before starting it");
	const port = z
		.number()
		.int()
		.min(1)
		.max(65535)
		.parse(options.port ?? DEFAULT_KEV_PORT);
	await verifyCheckout(root, install, deps);
	await checkDirectory(path.join(root, "repo", ".venv"));
	const current = await status(root, deps);
	if (current.state === "foreign" || current.state === "orphaned") throw new Error(current.error);
	if (current.state === "running" || current.state === "starting") {
		if (current.port !== port) throw new Error("Owned Kev server already uses a different port");
		return current;
	}
	if (!(deps.portAvailable ?? portAvailable)(port))
		throw new Error("Kev loopback port is occupied; no process was signaled");
	const socket = controlSocket(root);
	if (!controlSocketPathIsBindable(socket))
		throw new Error("Kev control socket path is too long for a Unix socket; choose a shorter --root");
	await fs.rm(socket, { force: true });
	await writePrivateText(path.join(root, SUPERVISOR_FILE), KEV_SUPERVISOR_SOURCE);
	await writePrivateText(path.join(root, SERVICE_SHIM_FILE), KEV_SERVICE_SHIM_SOURCE);
	const token = randomBytes(32).toString("hex");
	const logPath = path.join(root, "server.log");
	const log = await fs.open(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
	const ownerId = randomUUID();
	const argv = serviceArgv(root, install.snapshot, port, ownerId);
	let child: KevChild;
	try {
		const stat = await log.stat();
		// A second link to this inode is someone else's handle on the same bytes.
		// O_NOFOLLOW stops symlinks but not hard links, and the chmod/truncate below
		// would otherwise reach through to a file the user never meant to expose.
		if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()))
			throw new Error("Unsafe Kev log file");
		await log.chmod(0o600);
		await log.truncate(0);
		child = (deps.spawn ?? spawnDefault)(argv, {
			cwd: path.join(root, "repo"),
			env: environment(root),
			logPath,
			logFd: log.fd,
			token,
		});
	} finally {
		await log.close();
	}
	let published = false;
	try {
		let identity: KevProcessIdentity | undefined;
		for (let attempt = 0; attempt < 80; attempt++) {
			identity = (deps.inspect ?? inspectDefault)(child.pid);
			if (identity?.command === argv.join(" ")) break;
			await (deps.sleep ?? Bun.sleep)(25);
		}
		if (!identity || identity.command !== argv.join(" "))
			throw new Error("Unable to establish the spawned Kev process identity; inspect server.log");
		const record: ServiceRecord = {
			version: 2,
			pid: child.pid,
			ownerId,
			incarnation: identity.incarnation,
			argv,
			argvDigest: digest(argv),
			root,
			model: install.model,
			port,
			socket,
			token,
		};
		await writePrivate(path.join(root, SERVICE_FILE), record);
		published = true;
		// Only now may the supervisor start anything. Everything above is
		// recoverable by a later command; a service started before this point
		// would not be.
		child.commit();
		child.unref();
		const deadline = Date.now() + (deps.readyTimeoutMs ?? 30_000);
		do {
			const state = await status(root, deps);
			if (state.state !== "starting") {
				if (state.state === "stale") throw new Error("Kev exited before readiness; inspect server.log");
				return state;
			}
			await (deps.sleep ?? Bun.sleep)(100);
		} while (Date.now() < deadline);
		return { ok: true, state: "starting", root, model: install.model, port, pid: child.pid };
	} finally {
		if (!published) child.kill();
	}
}
/** Why a stop was not acknowledged. Ownership is retained in every one of these cases. */
function unconfirmedStopReason(reply: KevControlReply | undefined): string {
	const retained = "ownership retained and nothing was signaled";
	if (reply === undefined) return `Kev supervisor did not answer its control socket; ${retained}`;
	if (!reply.ok) return `Kev supervisor refused the stop (${reply.error ?? "unknown"}); ${retained}`;
	return `Kev supervisor did not confirm that the service exited; ${retained}`;
}
async function stopKev(root: string, deps: KevSetupDeps): Promise<KevStatus> {
	const current = await status(root, deps);
	if (current.state === "foreign") return current;
	const service = await readService(root);
	if (service.unsafe) return { ok: false, state: "foreign", root, error: "Invalid or unsafe Kev ownership metadata" };
	const record = service.record;
	if (!record) return { ok: true, state: "stopped", root };
	let install: Installation | undefined;
	try {
		install = await installed(root);
	} catch {
		install = undefined;
	}
	const observed = (deps.inspect ?? inspectDefault)(record.pid);
	// Ownership can become unprovable (installation metadata removed) while the
	// service keeps running. That is a reason to stop it through its own
	// authenticated channel, never a reason to call it stopped and walk away.
	if (install && observed && !owns(record, install, observed)) {
		return { ok: false, state: "foreign", root, error: "Kev ownership changed before stop" };
	}
	const retained = { root, model: record.model, port: record.port, pid: record.pid } as const;
	if (observed) {
		// Nothing below resolves `record.pid` into a signal. Ownership is proven to
		// the supervisor by a token over this installation's own socket, and the
		// supervisor signals a child handle it holds — so a pid recycled between the
		// check and the stop is never signaled, because no pid is ever signaled here.
		const reply = await (deps.control ?? kevControl)(controlSocket(root), controlRequest("stop", record.token));
		// Only a numeric exit status is a stop. A supervisor that answered without
		// reaping its child has not proven anything went away, so the record stays
		// and a later stop retries against the same channel.
		if (!isConfirmedStop(reply) && (deps.inspect ?? inspectDefault)(record.pid)) {
			return { ok: false, state: "stopping", ...retained, error: unconfirmedStopReason(reply) };
		}
	}
	// The supervisor is gone — confirmed, already absent, or exited mid-stop. The
	// record is retired only once the recorded port is actually free, so a child
	// that outlived its supervisor is reported rather than forgotten.
	if (!(await awaitPortRelease(record.port, deps))) {
		return {
			ok: false,
			state: "orphaned",
			...retained,
			error: "Kev stopped its supervisor but the recorded port still has a listener; ownership retained",
		};
	}
	await fs.rm(path.join(root, SERVICE_FILE), { force: true });
	return { ok: true, state: "stopped", root };
}

/** The authenticated channel to an owned, running Kev service. */
export interface KevServiceChannel {
	readonly socket: string;
	readonly token: string;
	readonly port: number;
}

function resolveRootSync(stateDir: string, pointerRoot: string | undefined, explicit?: string): string {
	return path.resolve(explicit ?? pointerRoot ?? path.join(stateDir, "kev"));
}

/**
 * Resolve the control channel of a Kev service this installation can prove it owns.
 *
 * Callers that want to reach the local server must go through this: it returns a
 * socket and token, never a URL, so inference cannot be aimed at whatever else
 * happens to be listening on the loopback port. `undefined` means no ownership
 * could be proven, and the caller must send nothing at all.
 */
export async function resolveKevServiceChannel(
	options: { root?: string } = {},
	deps: KevSetupDeps = {},
): Promise<KevServiceChannel | undefined> {
	try {
		const stateDir = path.resolve(deps.stateDir ?? getAgentDir());
		const pointer = options.root ? undefined : await readPrivate(path.join(stateDir, "kev-root.json"), pointerSchema);
		const root = resolveRootSync(stateDir, pointer?.root, options.root);
		if (!(await checkDirectory(root))) return undefined;
		const service = await readService(root);
		if (!service.record) return undefined;
		const install = await installed(root);
		if (!install) return undefined;
		const observed = (deps.inspect ?? inspectDefault)(service.record.pid);
		if (!observed || !owns(service.record, install, observed)) return undefined;
		return { socket: controlSocket(root), token: service.record.token, port: service.record.port };
	} catch {
		// Unreadable or unsafe local state proves nothing, so it grants nothing.
		return undefined;
	}
}

export async function runKevSetup(
	action: KevSetupAction,
	options: KevSetupOptions,
	deps: KevSetupDeps = {},
): Promise<KevStatus> {
	const stateDir = path.resolve(deps.stateDir ?? getAgentDir());
	const pointer = options.root ? undefined : await readPrivate(path.join(stateDir, "kev-root.json"), pointerSchema);
	const root = path.resolve(options.root ?? pointer?.root ?? path.join(stateDir, "kev"));
	let result: KevStatus;
	if (!(await checkDirectory(root, action === "install"))) {
		result = { ok: action === "stop", state: action === "stop" ? "stopped" : "not-installed", root };
	} else if (action === "status") {
		result = await status(root, deps);
	} else {
		await fs.chmod(root, 0o700);
		const lock = path.join(root, ".lifecycle");
		let releaseLock: (() => Promise<void>) | undefined;
		try {
			releaseLock = await acquireFileLock(lock, { retries: 3, retryDelayMs: 100 });
		} catch (error) {
			if (error instanceof FileLockAcquireError)
				throw new Error("Kev lifecycle is busy; inspect the existing lock before retrying");
			throw error;
		}
		try {
			result =
				action === "install"
					? await installKev(root, stateDir, options, deps)
					: action === "start"
						? await startKev(root, options, deps)
						: await stopKev(root, deps);
		} finally {
			await releaseLock?.();
		}
	}
	if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	return result;
}
