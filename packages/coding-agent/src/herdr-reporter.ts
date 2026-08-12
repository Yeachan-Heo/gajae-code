/**
 * Herdr agent lifecycle reporter.
 *
 * When gjc runs inside a Herdr pane (`HERDR_ENV=1`), report semantic agent
 * state through Herdr's custom-integration API so the pane is recognized as
 * the "gjc" agent in Herdr's sidebar and workspace rollups:
 *
 *   - `idle`    — waiting at the input prompt (also reported at startup)
 *   - `working` — agent turn in progress
 *   - `blocked` — waiting on a user decision (ask tool)
 *
 * This is the officially documented "integrate your own agent" path
 * (https://herdr.dev/docs/integrations/#integrate-your-own-agent) and works
 * without Herdr shipping native support for gjc. Outside a Herdr pane this
 * module is a no-op.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "./session/agent-session";

const AGENT_LABEL = "gjc";
const SOURCE = "custom:gjc";

type HerdrState = "idle" | "working" | "blocked" | "unknown";

interface HerdrEnvironment {
	paneId: string;
	binPath: string;
}

function debugLog(message: string): void {
	if (process.env.HERDR_REPORTER_DEBUG !== "1") return;
	try {
		appendFileSync(join(homedir(), ".gjc", "logs", "herdr-reporter.log"), `${new Date().toISOString()} ${message}\n`);
	} catch {
		// ignore
	}
}

function exeName(base: string): string {
	return process.platform === "win32" ? `${base}.exe` : base;
}

/** Locate the herdr CLI binary, independent of HERDR_BIN_PATH. */
function resolveHerdrBinPath(): string | null {
	if (process.env.HERDR_BIN_PATH) return process.env.HERDR_BIN_PATH;

	const home = homedir();
	const candidates: string[] = [];

	// PATH lookup (herdr installs a CLI shim into the user's PATH).
	const pathSeparator = process.platform === "win32" ? ";" : ":";
	for (const dir of (process.env.PATH ?? "").split(pathSeparator)) {
		if (!dir) continue;
		candidates.push(join(dir, exeName("herdr")));
	}

	// Known install roots (standalone layout used by the official installer).
	candidates.push(join(home, ".herdr", "packages", "standalone", "current", exeName("herdr")));

	// Versioned release layout: pick the most recently modified release dir.
	try {
		const releasesDir = join(home, ".herdr", "packages", "releases");
		const releases = readdirSync(releasesDir, { withFileTypes: true })
			.filter(entry => entry.isDirectory())
			.map(entry => join(releasesDir, entry.name, exeName("herdr")))
			.filter(path => existsSync(path))
			.sort((a, b) => modifiedMs(b) - modifiedMs(a));
		candidates.push(...releases);
	} catch {
		// No versioned release layout; standalone layout is enough.
	}

	return candidates.find(path => existsSync(path)) ?? null;
}

function modifiedMs(path: string): number {
	try {
		return statSync(path).mtime.getTime();
	} catch {
		return 0;
	}
}

function resolveHerdrEnvironment(): HerdrEnvironment | null {
	if (process.env.HERDR_ENV !== "1") return null;
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) return null;
	const binPath = resolveHerdrBinPath();
	if (!binPath) return null;
	return { paneId, binPath };
}

export interface HerdrReporter {
	/** Report a new agent state (deduplicated against the current state). */
	report(state: HerdrState, message?: string): void;
	/** Release the lifecycle authority for this pane. */
	release(): void;
	dispose(): void;
}

/**
 * Create a Herdr reporter bound to a pane. `subscribe` receives the session's
 * event stream; it is parameterized so the state machine is testable without
 * a live session.
 */
export function createHerdrReporter(
	env: HerdrEnvironment,
	subscribe: (listener: (event: { type: string; toolName?: string }) => void) => () => void,
): HerdrReporter {
	let seq = 0;
	let currentState: HerdrState | null = null;
	let released = false;
	let unsubscribe: (() => void) | null = null;

	const run = (args: string[], sync: boolean): void => {
		debugLog(`run sync=${sync} ${args.join(" ")}`);
		try {
			if (sync) {
				spawnSync(env.binPath, args, { stdio: "ignore", windowsHide: true });
				return;
			}
			const child = spawn(env.binPath, args, {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
			child.unref();
		} catch (error) {
			debugLog(`spawn failed: ${String(error)}`);
			// Reporting is best-effort; never let it disturb the agent.
		}
	};

	const report = (state: HerdrState, message?: string): void => {
		if (released || state === currentState) return;
		currentState = state;
		seq += 1;
		debugLog(`report ${state} seq=${seq}`);
		const args = [
			"pane",
			"report-agent",
			env.paneId,
			"--source",
			SOURCE,
			"--agent",
			AGENT_LABEL,
			"--state",
			state,
			"--seq",
			String(seq),
		];
		if (message) args.push("--message", message);
		run(args, false);
	};

	unsubscribe = subscribe(event => {
		switch (event.type) {
			case "agent_start":
				report("working");
				break;
			case "agent_end":
				report("idle");
				break;
			case "tool_execution_start":
				if (event.toolName === "ask") {
					report("blocked", "Waiting for your answer in the ask tool");
				}
				break;
			case "tool_execution_end":
				if (event.toolName === "ask") {
					report("working");
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
			if (unsubscribe) {
				unsubscribe();
				unsubscribe = null;
			}
			seq += 1;
			run(
				["pane", "release-agent", env.paneId, "--source", SOURCE, "--agent", AGENT_LABEL, "--seq", String(seq)],
				true,
			);
		},
		dispose() {
			if (unsubscribe) {
				unsubscribe();
				unsubscribe = null;
			}
		},
	};
}

/**
 * Install the Herdr reporter for a running agent session. No-op when gjc is
 * not running inside a Herdr pane. Herdr clears the authority automatically
 * when the pane's foreground process exits, so a hard kill still recovers.
 */
export function installHerdrReporter(session: AgentSession): void {
	const env = resolveHerdrEnvironment();
	debugLog(`install env=${JSON.stringify(env)}`);
	if (!env) return;
	const reporter = createHerdrReporter(env, listener => session.subscribe(listener));
	process.on("exit", () => {
		reporter.release();
	});
}
