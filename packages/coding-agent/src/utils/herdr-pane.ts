/**
 * Herdr agent lifecycle reporter.
 *
 * When gjc runs inside a Herdr pane (`HERDR_ENV=1`), report semantic agent
 * state through Herdr's documented custom-integration API so the pane is
 * recognized as the "gjc" agent in Herdr's sidebar and workspace rollups:
 *
 *   - `idle`    — waiting at the input prompt (also reported at startup)
 *   - `working` — agent turn in progress
 *   - `blocked` — waiting on a user decision (ask tool)
 *
 * The session title is reported through the same API as display-only pane
 * metadata, so a pane shows what it is working on instead of a bare agent
 * label. Herdr renders that title on the pane border and exposes it to the
 * sidebar as the `pane` token.
 *
 * Reporting is strictly best-effort and never blocks or fails a turn. Outside
 * a Herdr pane every entry point is a no-op. Herdr also clears the authority
 * when the pane's foreground process exits, so a hard kill still recovers.
 *
 * Original implementation contributed by @ox8884 (#4318).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { probeLinuxProcPidSync } from "../gjc-runtime/linux-proc";
import { processIncarnation } from "../sdk/broker/process-incarnation";

const HERDR_ENV = "HERDR_ENV";
const HERDR_PANE_ID_ENV = "HERDR_PANE_ID";
const HERDR_BIN_PATH_ENV = "HERDR_BIN_PATH";
/**
 * Stamped into the environment by the process that claims a pane, and therefore
 * inherited by everything it spawns. Herdr's pane variables are inherited the
 * same way, so without this marker a nested gjc — an agent shelling out to
 * `gjc doctor`, a scripted `gjc -p`, a subagent — looks exactly like the pane's
 * own session and claims the very same `custom:gjc` authority.
 */
const HERDR_PANE_OWNER_ENV = "GJC_HERDR_PANE_OWNER";
const HERDR_PANE_OWNER_VERSION = 1;
const HERDR_SOCKET_PATH_ENV = "HERDR_SOCKET_PATH";
/** Debounce between a socket directory event and reading the socket's identity. */
const SOCKET_SETTLE_MS = 150;
/** ~3s of re-checks while the path is empty between unlink and bind. */
const SOCKET_SETTLE_ATTEMPTS = 20;
const HERDR_COMMAND = "herdr";
const AGENT_LABEL = "gjc";
const SOURCE = "custom:gjc";
/** A report is a fire-and-forget status ping; a hung herdr CLI must never accumulate. */
const HERDR_REPORT_TIMEOUT_MS = 1500;
/** Release runs on the shutdown path, so it is bounded even tighter. */
const HERDR_RELEASE_TIMEOUT_MS = 1000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/** Herdr truncates to the pane width anyway; this only bounds the argv. */
const MAX_PANE_TITLE_CHARS = 120;
const HERDR_SEQUENCE_STATE_PATH = path.join(os.tmpdir(), "gjc-herdr-sequence-v1");

/**
 * The environment is inherited, not authoritative. The token prevents a
 * process that merely supplies a copied PID/incarnation in its environment
 * from being treated as the process that installed the claim. Descendants do
 * not need the token: they are rejected while the recorded owner incarnation
 * is still live, and a stale incarnation is reclaimed.
 */
const PROCESS_OWNER_TOKEN = crypto.randomUUID();

interface HerdrPaneOwnerMarker {
	version: typeof HERDR_PANE_OWNER_VERSION;
	paneId: string;
	pid: number;
	incarnation?: string;
	token: string;
}

/**
 * Herdr records the highest sequence it has accepted per source and drops any
 * later report that does not exceed it. That watermark belongs to the pane's
 * terminal, so it outlives the gjc process that set it: a counter restarting at
 * zero makes every report of the next session in that pane look stale, and the
 * session stays invisible in the sidebar until it happens to out-count its
 * predecessor. Seeding from wall-clock milliseconds keeps sequences rising
 * across processes, which is also what Herdr's own bundled integrations do.
 * The multiplier leaves 1000 sequence slots per millisecond, so a chatty
 * session cannot count past the seed of the process that replaces it.
 */
let sequenceFloor = 0;

function readSequenceFloor(): number {
	try {
		const value = Number.parseInt(fs.readFileSync(HERDR_SEQUENCE_STATE_PATH, "utf8"), 10);
		return Number.isSafeInteger(value) && value >= 0 ? value : 0;
	} catch {
		return 0;
	}
}

function persistSequenceFloor(value: number): void {
	try {
		const directory = path.dirname(HERDR_SEQUENCE_STATE_PATH);
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporary = `${HERDR_SEQUENCE_STATE_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
		fs.writeFileSync(temporary, String(value), { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, HERDR_SEQUENCE_STATE_PATH);
	} catch (error) {
		logger.debug("herdr sequence watermark persistence failed", { error: String(error) });
	}
}

function initialSeq(): number {
	sequenceFloor = Math.max(sequenceFloor + 1001, readSequenceFloor() + 1001, Date.now() * 1000);
	persistSequenceFloor(sequenceFloor);
	return sequenceFloor;
}

function nextSequence(current: number): number {
	sequenceFloor = Math.max(sequenceFloor + 1, current + 1, Date.now() * 1000);
	persistSequenceFloor(sequenceFloor);
	return sequenceFloor;
}

/**
 * Metadata reports carry their own per-source sequence in Herdr, independent of
 * the lifecycle-state sequence, so title updates need a counter of their own.
 * Module scope because the title is a property of the process, not of one
 * reporter instance: `setSessionTerminalTitle` is called from controllers that
 * never see the reporter.
 */
let metadataSeq = initialSeq();

function nextMetadataSeq(): number {
	metadataSeq = nextSequence(metadataSeq);
	return metadataSeq;
}

/**
 * Last title this process reported. A replaced Herdr server starts with an empty
 * metadata store, so the title has to be re-sent from here: the session name
 * lives in the session, not in Herdr, and nothing else would ever resend it.
 */
let lastReportedTitle: string | undefined;

export type HerdrAgentState = "idle" | "working" | "blocked";

export interface HerdrPaneEnvironment {
	paneId: string;
	binPath: string;
	/** Herdr's API socket, when the pane environment names one. Its identity is
	 * how a replaced server is detected; absent means replacement is undetectable
	 * and the reporter simply keeps its normal transition-driven behavior. */
	socketPath?: string;
}

export interface HerdrReportProcess {
	exited: Promise<number>;
	kill(): void;
	unref(): void;
}

export interface HerdrReporterOptions {
	env?: NodeJS.ProcessEnv;
	which?: (command: string) => string | null;
	/** Identity written into the ownership marker. Injectable so the nested-process
	 * case is testable without actually forking. */
	pid?: number;
	/** OS process incarnation probe, injectable for PID-reuse and recovery tests. */
	processIncarnation?: (pid: number) => string | undefined;
	/** Process liveness/incarnation probe, injectable for cross-platform recovery tests. */
	processProbe?: (pid: number) => HerdrProcessProbe;
	spawn?: (
		command: string[],
		options: { env: NodeJS.ProcessEnv; stdin: "ignore"; stdout: "ignore"; stderr: "ignore" },
	) => HerdrReportProcess;
	/** Watch for Herdr server replacement. Parameterized so the re-assert path is
	 * testable without a live server; returns a disposer. */
	watchServerReplacement?: (socketPath: string, onReplaced: () => void) => () => void;
}

export type HerdrProcessProbe =
	| { state: "live"; incarnation: string }
	| { state: "absent" }
	| { state: "unverifiable" };

/** Session event shape consumed by the reporter. Narrow on purpose: the state
 * machine is driven only by lifecycle transitions, never by message content. */
export interface HerdrSessionEvent {
	type: string;
	toolName?: string;
}

export interface HerdrReporter {
	/** Report a new agent state. Deduplicated against the last reported state. */
	report(state: HerdrAgentState): void;
	/** Release this pane's lifecycle authority and stop listening. Idempotent. */
	release(): void;
	/** Current reported state, for tests and diagnostics. */
	readonly state: HerdrAgentState | null;
}

function defaultSpawn(
	command: string[],
	options: { env: NodeJS.ProcessEnv; stdin: "ignore"; stdout: "ignore"; stderr: "ignore" },
): HerdrReportProcess {
	return Bun.spawn(command, options);
}

/**
 * Resolve the pane environment. Returns null unless gjc is demonstrably inside
 * a Herdr pane AND a herdr binary is resolvable.
 *
 * `HERDR_BIN_PATH` is honored first because Herdr sets it for its own panes;
 * otherwise the binary is resolved from PATH. No home-directory guessing: an
 * unverified path scavenged from an install layout is a command this process
 * would execute, and PATH/`HERDR_BIN_PATH` are the trust boundary Herdr itself
 * documents.
 *
 * Also returns null when an ancestor gjc already owns this pane, so a nested
 * invocation reports nothing at all.
 */
export function resolveHerdrPaneEnvironment(options: HerdrReporterOptions = {}): HerdrPaneEnvironment | null {
	const env = options.env ?? process.env;
	if (env[HERDR_ENV]?.trim() !== "1") return null;

	const paneId = env[HERDR_PANE_ID_ENV]?.trim();
	// A pane id is forwarded verbatim as an argv element; reject anything that is
	// not an opaque identifier rather than trusting the surrounding environment.
	// The leading character must be alphanumeric so a pane id can never be parsed
	// by the herdr CLI as an option.
	if (!paneId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(paneId)) return null;

	// A descendant must stay silent: it would claim the pane away from the session
	// the user is actually looking at, and on exit it releases that authority and
	// clears the title. Herdr's per-source sequence is a monotonic watermark, and
	// the descendant seeds its own from a later wall clock, so every subsequent
	// report from the real session is below the watermark and dropped. The pane
	// then vanishes from the agent list until the session is restarted.
	if (!mayClaimPane(env, paneId, options)) return null;

	const socketPath = env[HERDR_SOCKET_PATH_ENV]?.trim() || undefined;

	const configured = env[HERDR_BIN_PATH_ENV]?.trim();
	if (configured) return { paneId, binPath: configured, socketPath };

	const which = options.which ?? Bun.which;
	try {
		const resolved = which(HERDR_COMMAND);
		return resolved ? { paneId, binPath: resolved, socketPath } : null;
	} catch (error) {
		logger.debug("herdr binary lookup failed", { error: String(error) });
		return null;
	}
}

/**
 * Whether this process may report for `paneId`. True when nothing has claimed
 * the pane yet, or when the standing claim is this process's own. A claim for a
 * different pane is ignored rather than trusted: a stale marker inherited from
 * an unrelated pane must not silence a legitimate session.
 */
function readOwnerMarker(value: string | undefined): HerdrPaneOwnerMarker | null {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const marker = parsed as Record<string, unknown>;
		if (
			marker.version !== HERDR_PANE_OWNER_VERSION ||
			typeof marker.paneId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(marker.paneId) ||
			typeof marker.pid !== "number" ||
			!Number.isSafeInteger(marker.pid) ||
			marker.pid <= 0 ||
			(marker.incarnation !== undefined && typeof marker.incarnation !== "string") ||
			typeof marker.token !== "string" ||
			!/^[A-Za-z0-9_-]{16,128}$/.test(marker.token)
		)
			return null;
		return {
			version: HERDR_PANE_OWNER_VERSION,
			paneId: marker.paneId,
			pid: marker.pid,
			...(marker.incarnation === undefined ? {} : { incarnation: marker.incarnation }),
			token: marker.token,
		};
	} catch {
		return null;
	}
}

function ownerIncarnation(pid: number, options: HerdrReporterOptions): string | undefined {
	try {
		return (options.processIncarnation ?? processIncarnation)(pid);
	} catch (error) {
		logger.debug("herdr owner identity lookup failed", { error: String(error) });
		return undefined;
	}
}

type OwnerProcessState = "live" | "absent" | "reused" | "unverifiable";

function defaultProcessProbe(pid: number, expectedIncarnation: string): HerdrProcessProbe {
	if (process.platform === "linux") {
		const probe = probeLinuxProcPidSync(pid);
		if (probe.kind === "absent") return { state: "absent" };
		if (probe.kind !== "live") return { state: "unverifiable" };
		return `linux:${probe.startTime}` === expectedIncarnation
			? { state: "live", incarnation: expectedIncarnation }
			: { state: "live", incarnation: `linux:${probe.startTime}` };
	}

	try {
		const processHandle = nativeProcessBindings().Process.fromPid(pid) as { incarnation?: unknown } | null;
		if (processHandle === null) return { state: "absent" };
		if (typeof processHandle.incarnation !== "string") return { state: "unverifiable" };
		return { state: "live", incarnation: processHandle.incarnation };
	} catch (error) {
		logger.debug("herdr owner process probe failed", { error: String(error) });
		return { state: "unverifiable" };
	}
}

function inspectOwnerProcess(marker: HerdrPaneOwnerMarker, options: HerdrReporterOptions): OwnerProcessState {
	if (options.processProbe) {
		const probe = options.processProbe(marker.pid);
		if (probe.state === "absent") return "absent";
		if (probe.state === "unverifiable") return "unverifiable";
		return probe.incarnation === marker.incarnation ? "live" : "reused";
	}

	if (options.processIncarnation) {
		const incarnation = ownerIncarnation(marker.pid, options);
		if (incarnation === undefined) return "absent";
		return incarnation === marker.incarnation ? "live" : "reused";
	}

	const probe = defaultProcessProbe(marker.pid, marker.incarnation ?? "");
	if (probe.state === "absent") return "absent";
	if (probe.state === "unverifiable") return "unverifiable";
	return probe.incarnation === marker.incarnation ? "live" : "reused";
}

/**
 * Return true when this process may claim the pane. A live matching owner is
 * never displaced. An absent or PID-reused owner is reclaimed, while an
 * unverifiable owner fails closed so a permissions/platform gap cannot cause a
 * nested process to release the parent's authority.
 */
function mayClaimPane(env: NodeJS.ProcessEnv, paneId: string, options: HerdrReporterOptions): boolean {
	const raw = env[HERDR_PANE_OWNER_ENV]?.trim();
	if (!raw) return true;

	const marker = readOwnerMarker(raw);
	if (!marker || marker.paneId !== paneId) return true;

	const pid = options.pid ?? process.pid;
	if (marker.pid === pid) {
		if (marker.token === PROCESS_OWNER_TOKEN) return true;
		// A same-process marker supplied by the caller is not our claim. Remove it
		// before taking ownership rather than treating environment text as proof.
		delete env[HERDR_PANE_OWNER_ENV];
		return true;
	}

	if (!marker.incarnation) return false;
	const ownerState = inspectOwnerProcess(marker, options);
	if (ownerState === "live" || ownerState === "unverifiable") return false;

	// The PID now names a different process. This is the safe recovery path for
	// a descendant that outlived its parent or a reused PID.
	delete env[HERDR_PANE_OWNER_ENV];
	return true;
}

function buildOwnerMarker(paneId: string, pid: number, incarnation: string | undefined): string {
	const marker: HerdrPaneOwnerMarker = {
		version: HERDR_PANE_OWNER_VERSION,
		paneId,
		pid,
		token: PROCESS_OWNER_TOKEN,
		...(incarnation === undefined ? {} : { incarnation }),
	};
	return JSON.stringify(marker);
}

/**
 * Watch for the Herdr server being replaced under a live pane.
 *
 * A server restart or `herdr update --handoff` rebinds the same socket path to a
 * new inode, so the file identity — not its mere existence — is the signal. The
 * watch is on the containing directory because the socket itself is unlinked and
 * recreated, which would drop a watch bound to the old inode.
 */
function watchSocketReplacement(socketPath: string, onReplaced: () => void): () => void {
	const identity = (): string | undefined => {
		try {
			const stat = fs.lstatSync(socketPath);
			// Herdr publishes a Unix-domain socket directly. Do not follow a
			// symlink from an inherited environment into an unrelated directory.
			return stat.isSocket() ? `${stat.dev}:${stat.ino}` : undefined;
		} catch {
			return undefined;
		}
	};

	let seen = identity();
	let settle: ReturnType<typeof setTimeout> | undefined;
	let attempts = 0;
	let closed = false;
	let replacementPending = false;

	/**
	 * Replacement arrives as unlink-then-bind, and the watch usually only
	 * delivers the unlink: at that instant the path has no inode to compare. So
	 * an event schedules a bounded re-check instead of deciding immediately, and
	 * the window closes once the new socket appears or the retries run out.
	 */
	const check = (): void => {
		if (closed) return;
		settle = undefined;
		const current = identity();
		if (current === undefined) {
			if (attempts >= SOCKET_SETTLE_ATTEMPTS) return;
			attempts += 1;
			schedule();
			return;
		}
		attempts = 0;
		if (current === seen && !replacementPending) return;
		seen = current;
		replacementPending = false;
		onReplaced();
	};

	const schedule = (): void => {
		if (closed || settle) return;
		settle = setTimeout(check, SOCKET_SETTLE_MS);
		settle.unref?.();
	};

	let watcher: fs.FSWatcher;
	try {
		watcher = fs.watch(path.dirname(socketPath), (event, filename) => {
			if (filename && path.basename(String(filename)) !== path.basename(socketPath)) return;
			// Linux may recycle the same inode for an unlink-and-bind performed in
			// one scheduler tick. A matching directory rename is therefore proof of
			// a replacement even if the settled inode compares equal. A missing
			// filename cannot safely be attributed, so re-assert conservatively.
			if (event === "rename" || !filename) replacementPending = true;
			attempts = 0;
			schedule();
		});
	} catch (error) {
		// An unwatchable directory only costs the re-assert; never a session.
		logger.debug("herdr socket watch failed", { error: String(error) });
		return () => {};
	}
	watcher.unref?.();
	watcher.on("error", error => logger.debug("herdr socket watch error", { error: String(error) }));
	return () => {
		closed = true;
		if (settle) clearTimeout(settle);
		settle = undefined;
		try {
			watcher.close();
		} catch {}
	};
}

/** Build the argv for a state report. Exported for tests. */
export function buildHerdrReportArgs(paneId: string, state: HerdrAgentState, seq: number): string[] {
	return [
		"pane",
		"report-agent",
		paneId,
		"--source",
		SOURCE,
		"--agent",
		AGENT_LABEL,
		"--state",
		state,
		"--seq",
		String(seq),
	];
}

/** Build the argv for an authority release. Exported for tests. */
export function buildHerdrReleaseArgs(paneId: string, seq: number): string[] {
	return ["pane", "release-agent", paneId, "--source", SOURCE, "--agent", AGENT_LABEL, "--seq", String(seq)];
}

/**
 * Collapse a session name into a single-line pane title. Control characters are
 * removed rather than escaped: the value reaches a terminal surface, and a
 * model-generated session name must never be able to inject escapes.
 */
export function sanitizeHerdrPaneTitle(title: string | undefined): string | undefined {
	if (!title) return undefined;
	const sanitized = title.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
	if (!sanitized) return undefined;
	if (sanitized.length <= MAX_PANE_TITLE_CHARS) return sanitized;
	// Truncate by UTF-16 code units (the Herdr argv is a string), then step back
	// if the cut lands on the high surrogate of a pair so the title never ends
	// with a lone surrogate.
	let bound = MAX_PANE_TITLE_CHARS;
	const last = sanitized.charCodeAt(bound - 1);
	if (last >= 0xd800 && last <= 0xdbff) bound -= 1;
	return sanitized.slice(0, bound).trimEnd();
}

/** Build the argv for a pane title report. Exported for tests. */
export function buildHerdrTitleArgs(paneId: string, title: string, seq: number): string[] {
	return [
		"pane",
		"report-metadata",
		paneId,
		"--source",
		SOURCE,
		"--agent",
		AGENT_LABEL,
		"--title",
		title,
		"--seq",
		String(seq),
	];
}

/** Build the argv that retracts a previously reported pane title. Exported for tests. */
export function buildHerdrClearTitleArgs(paneId: string, seq: number): string[] {
	return ["pane", "report-metadata", paneId, "--source", SOURCE, "--clear-title", "--seq", String(seq)];
}

/**
 * Spawn a detached, timeout-bounded herdr CLI invocation. Every failure mode is
 * swallowed: a status ping must never surface in a session.
 */
function runHerdrCommand(binPath: string, args: string[], timeoutMs: number, options: HerdrReporterOptions): void {
	const env = options.env ?? process.env;
	const spawn = options.spawn ?? defaultSpawn;

	let proc: HerdrReportProcess;
	try {
		proc = spawn([binPath, ...args], {
			env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
	} catch (error) {
		// Missing/unexecutable binary: reporting is best-effort, never fatal.
		logger.debug("herdr report failed to start", { error: String(error) });
		return;
	}
	proc.unref();
	const timer = setTimeout(() => {
		try {
			proc.kill();
		} catch {}
	}, timeoutMs);
	timer.unref?.();
	// Bun.spawn surfaces spawn failure through `exited` rejection, so this
	// handler is what keeps an ENOENT from becoming an unhandled rejection.
	void proc.exited
		.then(exitCode => {
			clearTimeout(timer);
			if (exitCode !== 0) logger.debug("herdr report exited non-zero", { exitCode });
		})
		.catch(error => {
			clearTimeout(timer);
			logger.debug("herdr report failed", { error: String(error) });
		});
}

/**
 * Report the current session title for this pane. No-op outside a Herdr pane or
 * when the session has no usable name, so a pane keeps the last real title
 * instead of flickering to a placeholder during startup or a rename.
 */
export function syncHerdrPaneTitle(sessionName: string | undefined, options: HerdrReporterOptions = {}): void {
	const title = sanitizeHerdrPaneTitle(sessionName);
	if (!title) return;

	const paneEnv = resolveHerdrPaneEnvironment(options);
	if (!paneEnv) return;

	lastReportedTitle = title;
	runHerdrCommand(
		paneEnv.binPath,
		buildHerdrTitleArgs(paneEnv.paneId, title, nextMetadataSeq()),
		HERDR_REPORT_TIMEOUT_MS,
		options,
	);
}

/**
 * Create a reporter bound to a pane. `subscribe` supplies the session event
 * stream and is parameterized so the state machine is testable without a live
 * session.
 */
function createHerdrReporterWithClaim(
	paneEnv: HerdrPaneEnvironment,
	subscribe: (listener: (event: HerdrSessionEvent) => void) => () => void,
	options: HerdrReporterOptions = {},
	claimMarker?: string,
): HerdrReporter {
	let seq = initialSeq();
	let currentState: HerdrAgentState | null = null;
	let released = false;
	const releaseAuthority = claimMarker !== undefined;
	/** Nesting depth of blocking ask calls; a nested ask must not unblock early. */
	let askDepth = 0;

	const run = (args: string[], timeoutMs: number): void => {
		runHerdrCommand(paneEnv.binPath, args, timeoutMs, options);
	};

	const report = (state: HerdrAgentState): void => {
		if (released || state === currentState) return;
		currentState = state;
		seq = nextSequence(seq);
		run(buildHerdrReportArgs(paneEnv.paneId, state, seq), HERDR_REPORT_TIMEOUT_MS);
	};

	let unsubscribe: (() => void) | null = subscribe(event => {
		switch (event.type) {
			case "agent_start":
				askDepth = 0;
				report("working");
				break;
			case "agent_end":
				askDepth = 0;
				report("idle");
				break;
			case "tool_execution_start":
				if (event.toolName === "ask") {
					askDepth += 1;
					report("blocked");
				}
				break;
			case "tool_execution_end":
				if (event.toolName === "ask" && askDepth > 0) {
					askDepth -= 1;
					if (askDepth === 0) report("working");
				}
				break;
		}
	});

	// A freshly started agent is idle at the prompt.
	report("idle");

	/**
	 * A replaced server starts with an empty agent registry, and `report` is
	 * deduplicated against the last state, so a session sitting at its prompt
	 * would stay invisible in the sidebar until it happened to change state.
	 * Clearing the memo forces the next report through.
	 */
	const reassert = (): void => {
		if (released) return;
		const state = currentState ?? "idle";
		currentState = null;
		report(state);
		if (lastReportedTitle) {
			run(buildHerdrTitleArgs(paneEnv.paneId, lastReportedTitle, nextMetadataSeq()), HERDR_REPORT_TIMEOUT_MS);
		}
	};

	const watch = options.watchServerReplacement ?? watchSocketReplacement;
	let unwatch: (() => void) | null = paneEnv.socketPath ? watch(paneEnv.socketPath, reassert) : null;

	return {
		report,
		release() {
			if (released) return;
			released = true;
			unsubscribe?.();
			unsubscribe = null;
			unwatch?.();
			unwatch = null;
			if (!releaseAuthority) return;
			const env = options.env ?? process.env;
			if (claimMarker !== undefined && env[HERDR_PANE_OWNER_ENV] === claimMarker) delete env[HERDR_PANE_OWNER_ENV];
			seq = nextSequence(seq);
			run(buildHerdrReleaseArgs(paneEnv.paneId, seq), HERDR_RELEASE_TIMEOUT_MS);
			// The pane outlives gjc, so a session title left behind would label a
			// plain shell with the work of a session that already ended.
			run(buildHerdrClearTitleArgs(paneEnv.paneId, nextMetadataSeq()), HERDR_RELEASE_TIMEOUT_MS);
		},
		get state() {
			return currentState;
		},
	};
}

export function createHerdrReporter(
	paneEnv: HerdrPaneEnvironment,
	subscribe: (listener: (event: HerdrSessionEvent) => void) => () => void,
	options: HerdrReporterOptions = {},
): HerdrReporter {
	return createHerdrReporterWithClaim(paneEnv, subscribe, options);
}

/**
 * Install the Herdr reporter for a running session. No-op outside a Herdr pane.
 * Returns the reporter so callers can release it deterministically, or null.
 */
export function installHerdrReporter(
	subscribe: (listener: (event: HerdrSessionEvent) => void) => () => void,
	options: HerdrReporterOptions = {},
): HerdrReporter | null {
	const paneEnv = resolveHerdrPaneEnvironment(options);
	if (!paneEnv) return null;

	// Claim the pane before the first report. Written to the live environment so
	// every process this session spawns inherits it and defers to this one; the
	// claim dies with the process, which is exactly when the pane is up for grabs
	// again.
	const env = options.env ?? process.env;
	const claimMarker = buildOwnerMarker(
		paneEnv.paneId,
		options.pid ?? process.pid,
		ownerIncarnation(options.pid ?? process.pid, options),
	);
	env[HERDR_PANE_OWNER_ENV] = claimMarker;

	const reporter = createHerdrReporterWithClaim(paneEnv, subscribe, options, claimMarker);
	// `exit` handlers must be synchronous; release() only spawns and returns.
	process.once("exit", reporter.release);
	return reporter;
}
