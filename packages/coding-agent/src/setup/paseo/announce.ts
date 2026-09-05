/**
 * Announce a live interactive session to Paseo so it appears there as a
 * controllable ACP agent.
 *
 * `gjc setup paseo` registers GJC as an ACP provider, but Paseo only ever knows
 * about the sessions it started itself. Everything else is already in place: an
 * interactive `gjc` hosts a broker-registered SDK endpoint, and GJC's own ACP
 * surface resolves a *live* index entry straight to that running host -- a
 * `session/load` attaches to it instead of resuming a second copy. The one
 * missing step is telling the Paseo daemon that the session exists, which is
 * exactly what `paseo import` does.
 *
 * Two hard constraints shape this module:
 *
 * - The Paseo CLI blocks indefinitely when its daemon is not running (measured:
 *   no output and no exit after two minutes). It is therefore NEVER spawned
 *   before a cheap socket probe proves something is listening.
 * - ACP `session/load` only attaches to a session the broker index reports as
 *   live; for anything else it falls back to `session.resume`, which would start
 *   a *second* host for a session that is actually running. Liveness is
 *   confirmed before the import, never assumed.
 *
 * Everything here is best-effort: no Paseo, a stopped daemon, or a failed import
 * must never slow down or break an interactive launch. It is also opt-in: the
 * caller checks `paseo.autoImport` before any of this runs, so an installation
 * that never asked for it pays nothing at all.
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { $which, logger } from "@gajae-code/utils";
import { AgentDirSessionLifecycleClient } from "../../sdk/lifecycle/broker-client";
import { sessionListPageFromResponse, traverseSessionList } from "../../sdk/session-list";
import { PROVIDER_EXTENDS, PROVIDER_KEY, resolvePaseoHome } from "./setup-deps";

/** Cheap liveness probe of the daemon socket. Only gates the expensive CLI spawn. */
const DAEMON_PROBE_TIMEOUT_MS = 750;
/** Bound on the broker `session.list` traversal that proves our own liveness. */
const BROKER_QUERY_TIMEOUT_MS = 5_000;
/** `paseo import` spawns Electron, probes the provider, and replays history. */
const IMPORT_TIMEOUT_MS = 90_000;
/** Cadence of the retry loop while the daemon is simply not up yet. */
const RETRY_INTERVAL_MS = 30_000;
/** Retries stop after ten minutes so a launch never keeps a timer alive forever. */
const MAX_ATTEMPTS = 20;

/** Paseo's own default when nothing configures a listener. */
const DEFAULT_DAEMON_TARGET: PaseoDaemonTarget = { kind: "tcp", host: "localhost", port: 6767 };

export type PaseoDaemonTarget =
	| { readonly kind: "ipc"; readonly socketPath: string }
	| { readonly kind: "tcp"; readonly host: string; readonly port: number };

/** Why an announcement did nothing. Each reason is a distinct, actionable state. */
export type PaseoAnnounceSkip =
	| "no-paseo-config"
	| "no-provider"
	| "cli-missing"
	| "daemon-unreachable"
	| "unsupported-daemon-target"
	| "daemon-auth-required"
	| "session-not-live";

export type PaseoAnnounceOutcome =
	| { readonly kind: "imported"; readonly providerKey: string }
	| { readonly kind: "already-imported"; readonly providerKey: string }
	| { readonly kind: "skipped"; readonly reason: PaseoAnnounceSkip }
	| { readonly kind: "failed"; readonly detail: string };

export interface PaseoAnnounceDependencies {
	/** `~/.paseo/config.json` (or the `$PASEO_HOME` equivalent). */
	readonly configJson: string;
	/** `~/.paseo` (or `$PASEO_HOME`). */
	readonly paseoHome: string;
	readonly env: NodeJS.ProcessEnv;
	/** Parsed JSON, or `undefined` when the file is absent or unreadable. */
	readJson(file: string): Promise<unknown>;
	/** Absolute path of the `paseo` CLI, or `undefined` when it is not installed. */
	resolveCli(): string | undefined;
	probeDaemon(target: PaseoDaemonTarget): Promise<boolean>;
	/** True only when the broker index reports this session id as live in `cwd`. */
	isSessionLive(sessionId: string, cwd: string): Promise<boolean>;
	runImport(input: {
		readonly cli: string;
		readonly providerKey: string;
		readonly cwd: string;
		readonly sessionId: string;
		readonly signal?: AbortSignal;
	}): Promise<PaseoAnnounceOutcome>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Pick the Paseo provider entry to import under.
 *
 * `gjc setup paseo` writes `gjc`, and `--mpreset <name>` writes `gjc-<name>`, so
 * the base key is preferred and a preset provider is only used when it is the
 * only one installed. A disabled entry is never selected: Paseo would refuse to
 * launch it.
 */
export function selectProviderKey(config: unknown): string | undefined {
	const providers = asRecord(asRecord(asRecord(config)?.agents)?.providers);
	if (!providers) return undefined;
	const usable = (key: string): boolean => {
		const entry = asRecord(providers[key]);
		if (entry === undefined || entry.enabled === false || entry.extends !== PROVIDER_EXTENDS) return false;
		if (typeof entry.label !== "string" || !entry.label.startsWith("Gajae Code")) return false;
		const command = entry.command;
		return Array.isArray(command) && command.every(value => typeof value === "string") && command.includes("acp");
	};
	if (usable(PROVIDER_KEY)) return PROVIDER_KEY;
	return Object.keys(providers)
		.filter(key => key.startsWith(`${PROVIDER_KEY}-`) && usable(key))
		.sort()[0];
}

/**
 * Parse one Paseo listener spelling into a connectable target.
 *
 * Mirrors the spellings Paseo's own CLI accepts: `unix://`/`pipe://` prefixes, a
 * bare absolute path, a bare port, `tcp://host:port`, and plain `host:port`.
 */
export function parseDaemonListen(raw: string): PaseoDaemonTarget | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("unix://")) {
		const socketPath = trimmed.slice("unix://".length).trim();
		return socketPath ? { kind: "ipc", socketPath } : undefined;
	}
	if (trimmed.startsWith("pipe://") || trimmed.startsWith("\\\\.\\pipe\\")) {
		const socketPath = trimmed.startsWith("pipe://") ? trimmed.slice("pipe://".length).trim() : trimmed;
		return socketPath ? { kind: "ipc", socketPath } : undefined;
	}
	if (trimmed.startsWith("/")) return { kind: "ipc", socketPath: trimmed };
	if (/^\d+$/.test(trimmed)) {
		const port = Number(trimmed);
		return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
			? { kind: "tcp", host: "127.0.0.1", port }
			: undefined;
	}
	const authority = trimmed.startsWith("tcp://") ? trimmed.slice("tcp://".length) : trimmed;
	const withoutQuery = authority.split("?")[0] ?? "";
	const separator = withoutQuery.lastIndexOf(":");
	if (separator <= 0) return undefined;
	const port = Number(withoutQuery.slice(separator + 1));
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
	const host = withoutQuery.slice(0, separator).replace(/^\[|]$/g, "");
	return host ? { kind: "tcp", host, port } : undefined;
}

/**
 * Resolve where the daemon listens, in the same precedence Paseo's CLI uses:
 * environment override, then the running daemon's own pid file, then the
 * configured listener, then Paseo's default.
 */
export async function resolveDaemonTarget(
	config: unknown,
	deps: Pick<PaseoAnnounceDependencies, "env" | "paseoHome" | "readJson">,
): Promise<PaseoDaemonTarget | undefined> {
	const explicitHost = deps.env.PASEO_HOST?.trim();
	if (explicitHost) {
		return parseDaemonListen(explicitHost);
	}
	const explicitListen = deps.env.PASEO_LISTEN?.trim();
	if (explicitListen) return parseDaemonListen(explicitListen);

	const pidFile = asRecord(await deps.readJson(path.join(deps.paseoHome, "paseo.pid")));
	const pidListen = typeof pidFile?.listen === "string" ? pidFile.listen : pidFile?.sockPath;
	const pidTarget = typeof pidListen === "string" ? parseDaemonListen(pidListen) : undefined;
	if (pidTarget?.kind === "ipc") return pidTarget;

	const parsed = asRecord(config);
	const configured = asRecord(parsed?.daemon)?.listen ?? parsed?.listen;
	if (typeof configured !== "string") return DEFAULT_DAEMON_TARGET;
	const configuredTarget = parseDaemonListen(configured);
	if (!configuredTarget) return DEFAULT_DAEMON_TARGET;
	if (configuredTarget.kind === "tcp" && configuredTarget.host === "127.0.0.1" && configuredTarget.port === 6767) {
		return DEFAULT_DAEMON_TARGET;
	}
	return configuredTarget;
}

/**
 * Turn a non-zero `paseo import` into an outcome.
 *
 * Two of Paseo's refusals are not failures:
 *
 * - an already-known session is exactly the state we wanted to reach;
 * - a password-protected daemon (`Cannot connect to daemon ...: Password
 *   required`) is a configuration the user chose. The socket probe cannot see
 *   it -- the TCP connect succeeds -- so it can only be recognized here, and
 *   reporting it would put an error on screen at every single launch for
 *   something GJC must not fix on its own. Exporting `PASEO_PASSWORD` makes it
 *   work, since the CLI inherits this process's environment.
 */
export function classifyImportFailure(providerKey: string, detail: string): PaseoAnnounceOutcome {
	if (/already imported/i.test(detail)) return { kind: "already-imported", providerKey };
	if (/cannot connect to daemon[^\n]*password required/i.test(detail)) {
		return { kind: "skipped", reason: "daemon-auth-required" };
	}
	return { kind: "failed", detail: "paseo import failed; inspect the Paseo daemon log" };
}

/**
 * Run the full announcement once.
 *
 * The order is load-bearing: every cheap filesystem check runs before the socket
 * probe, and the socket probe runs before anything spawns the Paseo CLI.
 */
export async function announceSessionToPaseo(
	input: { readonly sessionId: string; readonly cwd: string },
	deps: PaseoAnnounceDependencies,
	signal?: AbortSignal,
): Promise<PaseoAnnounceOutcome> {
	if (signal?.aborted) return { kind: "failed", detail: "Paseo announcement cancelled" };
	const config = await deps.readJson(deps.configJson);
	if (signal?.aborted) return { kind: "failed", detail: "Paseo announcement cancelled" };
	if (config === undefined) return { kind: "skipped", reason: "no-paseo-config" };

	const providerKey = selectProviderKey(config);
	if (!providerKey) return { kind: "skipped", reason: "no-provider" };

	const cli = deps.resolveCli();
	if (!cli) return { kind: "skipped", reason: "cli-missing" };

	const target = await resolveDaemonTarget(config, deps);
	if ((deps.env.PASEO_HOST?.trim() || deps.env.PASEO_LISTEN?.trim()) && target === undefined)
		return { kind: "skipped", reason: "unsupported-daemon-target" };
	if (!target || !(await deps.probeDaemon(target))) return { kind: "skipped", reason: "daemon-unreachable" };
	if (signal?.aborted) return { kind: "failed", detail: "Paseo announcement cancelled" };

	// Importing a session the broker does not yet report as live would make ACP
	// `session/load` resume a copy instead of attaching to the running host.
	if (!(await deps.isSessionLive(input.sessionId, input.cwd))) return { kind: "skipped", reason: "session-not-live" };

	return await deps.runImport({ cli, providerKey, cwd: input.cwd, sessionId: input.sessionId, signal });
}

/** Only a daemon that is not up yet, or a registration that has not landed yet, is worth retrying. */
export function isRetryableOutcome(outcome: PaseoAnnounceOutcome): boolean {
	return (
		outcome.kind === "skipped" && (outcome.reason === "daemon-unreachable" || outcome.reason === "session-not-live")
	);
}

export interface PaseoAnnouncementHandle {
	cancel(): void;
}

/**
 * Announce the session, retrying only while Paseo is not ready to hear it.
 *
 * The user routinely opens Paseo after their terminal, so a single attempt at
 * launch would silently never land. Retries are socket probes, not CLI spawns,
 * and every timer is unref'd so the loop can never hold the process open.
 */
export function startPaseoAnnouncement(
	input: {
		readonly sessionId: string;
		readonly cwd: string;
		isEnabled?: () => boolean;
		onOutcome?: (outcome: PaseoAnnounceOutcome) => void;
	},
	deps: PaseoAnnounceDependencies,
): PaseoAnnouncementHandle {
	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const controller = new AbortController();

	const attempt = async (remaining: number): Promise<void> => {
		if (cancelled || input.isEnabled?.() === false) return;
		let outcome: PaseoAnnounceOutcome;
		try {
			outcome = await announceSessionToPaseo(input, deps, controller.signal);
		} catch (error) {
			outcome = { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
		}
		if (cancelled || input.isEnabled?.() === false) return;
		if (isRetryableOutcome(outcome) && remaining > 1) {
			// Logged per attempt: a retried outcome is otherwise completely silent,
			// which is the exact state a user reports as "it never showed up".
			logger.debug("Paseo session announcement retrying", { outcome, remaining: remaining - 1 });
			timer = setTimeout(() => void attempt(remaining - 1), RETRY_INTERVAL_MS);
			timer.unref?.();
			return;
		}
		logger.debug("Paseo session announcement settled", { outcome });
		try {
			input.onOutcome?.(outcome);
		} catch (error) {
			logger.debug("Paseo session announcement outcome handler failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	void attempt(MAX_ATTEMPTS);
	return {
		cancel(): void {
			cancelled = true;
			controller.abort();
			if (timer) clearTimeout(timer);
		},
	};
}

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await Bun.file(file).text());
	} catch {
		return undefined;
	}
}

function probeDaemon(target: PaseoDaemonTarget): Promise<boolean> {
	return new Promise(resolve => {
		let settled = false;
		const settle = (reachable: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(reachable);
		};
		const socket =
			target.kind === "ipc"
				? net.connect({ path: target.socketPath })
				: net.connect({ host: target.host, port: target.port });
		socket.setTimeout(DAEMON_PROBE_TIMEOUT_MS);
		socket.once("connect", () => settle(true));
		socket.once("timeout", () => settle(false));
		socket.once("error", () => settle(false));
	});
}

function isSessionLive(agentDir: string): (sessionId: string, cwd: string) => Promise<boolean> {
	return async (sessionId, cwd) => {
		const canonicalCwd = await fs.realpath(cwd).catch(() => path.resolve(cwd));
		const client = new AgentDirSessionLifecycleClient(agentDir);
		const pages = await traverseSessionList(
			{},
			pageInput => client.global("session.list", pageInput, { timeoutMs: BROKER_QUERY_TIMEOUT_MS }),
			response => sessionListPageFromResponse(response),
		);
		for (const { sessions } of pages) {
			if (sessionListContainsLiveSession(sessions, sessionId, canonicalCwd)) return true;
		}
		return false;
	};
}

export function sessionListContainsLiveSession(sessions: readonly unknown[], sessionId: string, cwd: string): boolean {
	for (const value of sessions) {
		const session = asRecord(value);
		if (session?.sessionId !== sessionId || session.live !== true) continue;
		const locatorCwd = asRecord(session.locator)?.cwd;
		if (typeof locatorCwd === "string" && path.resolve(locatorCwd) === path.resolve(cwd)) return true;
	}
	return false;
}

/**
 * Run `paseo import` with the session's own environment.
 *
 * GJC never reads a Paseo credential and has no setting of its own for one. The
 * CLI authenticates exactly as it would if the user ran it by hand: if
 * `PASEO_PASSWORD` is exported it is inherited, and if it is not, a
 * password-protected daemon refuses and the announcement becomes a quiet skip.
 */
function runImport(env: NodeJS.ProcessEnv) {
	return async (input: {
		readonly cli: string;
		readonly providerKey: string;
		readonly cwd: string;
		readonly sessionId: string;
		readonly signal?: AbortSignal;
	}): Promise<PaseoAnnounceOutcome> => {
		const timeoutController = new AbortController();
		const signal = input.signal
			? AbortSignal.any([input.signal, timeoutController.signal])
			: timeoutController.signal;
		const timer = setTimeout(() => timeoutController.abort(), IMPORT_TIMEOUT_MS);
		try {
			const child = Bun.spawn(
				[input.cli, "import", "--provider", input.providerKey, "--cwd", input.cwd, input.sessionId],
				{ stdout: "pipe", stderr: "pipe", signal, env },
			);
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			if (input.signal?.aborted) return { kind: "failed", detail: "Paseo announcement cancelled" };
			if (timeoutController.signal.aborted)
				return { kind: "failed", detail: `paseo import timed out after ${IMPORT_TIMEOUT_MS}ms` };
			if (exitCode === 0) return { kind: "imported", providerKey: input.providerKey };
			return classifyImportFailure(input.providerKey, stderr.trim() || `paseo import exited with ${exitCode}`);
		} catch (error) {
			return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	};
}

export function createDefaultPaseoAnnounceDependencies(
	agentDir: string,
	env: NodeJS.ProcessEnv = process.env,
): PaseoAnnounceDependencies {
	const paseoHome = resolvePaseoHome(env);
	return {
		configJson: path.join(paseoHome, "config.json"),
		paseoHome,
		env,
		readJson,
		// Resolve against the injected environment, not the ambient one: the env is a
		// dependency here, and a lookup that ignores it would resolve a different
		// executable than every other step in this module reasons about.
		resolveCli: () => $which("paseo", env.PATH === undefined ? undefined : { PATH: env.PATH }) ?? undefined,
		probeDaemon,
		isSessionLive: isSessionLive(agentDir),
		runImport: runImport(env),
	};
}
