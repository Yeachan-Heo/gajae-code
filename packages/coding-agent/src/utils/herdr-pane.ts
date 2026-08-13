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
import { logger } from "@gajae-code/utils";

const HERDR_ENV = "HERDR_ENV";
const HERDR_PANE_ID_ENV = "HERDR_PANE_ID";
const HERDR_BIN_PATH_ENV = "HERDR_BIN_PATH";
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

/**
 * Metadata reports carry their own per-source sequence in Herdr, independent of
 * the lifecycle-state sequence, so title updates need a counter of their own.
 * Module scope because the title is a property of the process, not of one
 * reporter instance: `setSessionTerminalTitle` is called from controllers that
 * never see the reporter.
 */
let metadataSeq = 0;

function nextMetadataSeq(): number {
	metadataSeq += 1;
	return metadataSeq;
}

export type HerdrAgentState = "idle" | "working" | "blocked";

export interface HerdrPaneEnvironment {
	paneId: string;
	binPath: string;
}

export interface HerdrReportProcess {
	exited: Promise<number>;
	kill(): void;
	unref(): void;
}

export interface HerdrReporterOptions {
	env?: NodeJS.ProcessEnv;
	which?: (command: string) => string | null;
	spawn?: (
		command: string[],
		options: { env: NodeJS.ProcessEnv; stdin: "ignore"; stdout: "ignore"; stderr: "ignore" },
	) => HerdrReportProcess;
}

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

	const configured = env[HERDR_BIN_PATH_ENV]?.trim();
	if (configured) return { paneId, binPath: configured };

	const which = options.which ?? Bun.which;
	try {
		const resolved = which(HERDR_COMMAND);
		return resolved ? { paneId, binPath: resolved } : null;
	} catch (error) {
		logger.debug("herdr binary lookup failed", { error: String(error) });
		return null;
	}
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
export function createHerdrReporter(
	paneEnv: HerdrPaneEnvironment,
	subscribe: (listener: (event: HerdrSessionEvent) => void) => () => void,
	options: HerdrReporterOptions = {},
): HerdrReporter {
	let seq = 0;
	let currentState: HerdrAgentState | null = null;
	let released = false;
	/** Nesting depth of blocking ask calls; a nested ask must not unblock early. */
	let askDepth = 0;

	const run = (args: string[], timeoutMs: number): void => {
		runHerdrCommand(paneEnv.binPath, args, timeoutMs, options);
	};

	const report = (state: HerdrAgentState): void => {
		if (released || state === currentState) return;
		currentState = state;
		seq += 1;
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

	return {
		report,
		release() {
			if (released) return;
			released = true;
			unsubscribe?.();
			unsubscribe = null;
			seq += 1;
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

	const reporter = createHerdrReporter(paneEnv, subscribe, options);
	// `exit` handlers must be synchronous; release() only spawns and returns.
	process.once("exit", reporter.release);
	return reporter;
}
