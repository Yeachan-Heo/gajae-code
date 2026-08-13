/**
 * `gjc master` — launch a resident master session.
 *
 * A master session is an otherwise normal interactive GJC session launched with
 * `--master`: the system prompt gains the dedicated master-mode section and the
 * session-start hook injects the SDK supervision guidelines plus the current
 * authoritative resident-session inventory. All launch flags pass through
 * unchanged (e.g. `gjc master --model opus`).
 */
import { getAgentDir, setProjectDir } from "@gajae-code/utils";
import { Command } from "@gajae-code/utils/cli";
import { assertLocalLaunchArgs, parseArgs } from "../cli/args";
import { launchDefaultTmuxIfNeeded } from "../gjc-runtime/launch-tmux";
import { type PreparedLaunchWorktree, prepareLaunchWorktree } from "../gjc-runtime/launch-worktree";
import { runRootCommand } from "../main";
import { resolveMasterResume } from "../master/registry";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";
import { persistCoordinatorLaunchFailure } from "./launch";

/**
 * Replace any continue/resume tokens in a launch argv with an exact
 * `--resume <sessionId>` for the registry-verified master session. Pure and
 * exported for tests; tmux/worktree relaunches receive the rewritten argv, so
 * the verified identity survives every handoff.
 */
export function rewriteMasterContinuationArgs(args: string[], sessionId: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--continue" || arg === "-c") continue;
		if (arg === "--resume" || arg === "-r" || arg === "--session") {
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-")) i++;
			continue;
		}
		if (arg.startsWith("--resume=") || arg.startsWith("--session=")) continue;
		out.push(arg);
	}
	out.push("--resume", sessionId);
	return out;
}

export default class Master extends Command {
	static description =
		"Launch a resident master session that supervises other resident GJC sessions through the SDK/ACP control surface";

	static examples = [
		"# Start a master session\n  gjc master",
		"# Master session with a specific model\n  gjc master --model opus",
		"# Master session continuing a previous master session\n  gjc master --continue",
	];

	static strict = false;

	async run(): Promise<void> {
		const { args } = prepareAcpTerminalAuthArgs(this.argv);
		const masterArgs = ["--master", ...args];
		const parsed = parseArgs([...masterArgs], "deferred");
		if (parsed.mode !== "acp") assertLocalLaunchArgs(parsed);
		if (parsed.help || parsed.version) {
			await runRootCommand(parsed, masterArgs);
			return;
		}
		// Continuation must preserve master identity exactly: resolve the durable
		// registry before any launch step and rewrite to an exact `--resume <id>`.
		// Ordinary sessions are never converted into masters by continuation.
		let launchArgs = masterArgs;
		if (parsed.continue === true || parsed.resume !== undefined) {
			const requestedId = typeof parsed.resume === "string" ? parsed.resume : undefined;
			const resolution = await resolveMasterResume(getAgentDir(), process.cwd(), requestedId);
			if (!resolution.ok) {
				process.stderr.write(`${resolution.message}\n`);
				process.exitCode = 1;
				return;
			}
			launchArgs = rewriteMasterContinuationArgs(masterArgs, resolution.sessionId);
		}

		let launch: PreparedLaunchWorktree;
		try {
			launch = prepareLaunchWorktree(process.cwd(), launchArgs);
		} catch (error) {
			await persistCoordinatorLaunchFailure(error, process.cwd());
			throw error;
		}
		if (launch.worktree.enabled) {
			process.chdir(launch.cwd);
			setProjectDir(launch.cwd);
		}
		const launchParsed = parseArgs(launch.args, "deferred");
		if (launchParsed.mode !== "acp") assertLocalLaunchArgs(launchParsed);
		if (
			launchDefaultTmuxIfNeeded({
				parsed: launchParsed,
				rawArgs: launch.args,
				cwd: launch.cwd,
				worktreeBranch: launch.worktree.enabled && !launch.worktree.detached ? launch.worktree.branchName : null,
				project: launch.cwd,
			})
		)
			return;
		await runRootCommand(launchParsed, launch.args);
	}
}
