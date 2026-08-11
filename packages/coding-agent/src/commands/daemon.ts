/**
 * Manage GJC background daemons (status/list/stop/reload).
 */
import { Args, CliParseError, Command, Flags } from "@gajae-code/utils/cli";
import {
	type DaemonCommandAction,
	type DaemonCommandArgs,
	isDaemonInternalAction,
	runDaemonCommand,
} from "../cli/daemon-cli";
import type { DaemonKind } from "../daemon/control-types";
import { DAEMON_ACTION_TOKENS, resolveDaemonAction } from "../daemon/operator-contract";
import { initTheme } from "../modes/theme/theme";

const ACTIONS = [...DAEMON_ACTION_TOKENS, "discord-internal", "slack-internal"] as const;

function parsePositiveTimeout(raw: string | undefined, flagName: string): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^[0-9]+$/.test(raw)) {
		throw new CliParseError(`Expected ${flagName} to be a positive safe integer, got "${raw}"`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new CliParseError(`Expected ${flagName} to be a positive safe integer, got "${raw}"`);
	}
	return value;
}

export default class Daemon extends Command {
	static description =
		"Manage GJC background daemons. Routine use: `gjc daemon status` to check, `gjc daemon restart` to reload (spawns one if none is running). `stop`/`list` and the escalation flags below are advanced primitives.";

	static examples = [
		"# Check the daemon (concise per-daemon result)\n  gjc daemon status",
		"# Reload, spawning a fresh owner if none is running\n  gjc daemon restart",
		"# Full runtime detail and the roots list\n  gjc daemon status --verbose",
		"# Machine-readable output for automation\n  gjc daemon status --json",
		"# Stop, hard-killing an unresponsive owner\n  gjc daemon stop --force",
	];

	static args = {
		action: Args.string({
			description: "Daemon action (status, restart, reload, stop, list)",
			required: false,
			options: [...ACTIONS] as string[],
		}),
		kind: Args.string({ description: "Daemon kind(s) to target", required: false, multiple: true }),
	};

	static flags = {
		verbose: Flags.boolean({ char: "v", description: "Show runtime detail and the full roots list" }),
		all: Flags.boolean({ description: "Target all registered daemon kinds" }),
		json: Flags.boolean({ description: "Emit JSON output" }),
		force: Flags.boolean({ description: "Allow hard-kill escalation when graceful stop times out" }),
		"graceful-timeout-ms": Flags.string({ description: "Cooperative stop timeout before escalation" }),
		"kill-timeout-ms": Flags.string({ description: "Wait for old pid death after SIGKILL" }),
		"spawn-if-stopped": Flags.boolean({ description: "On reload, spawn even when no daemon is running" }),
		smoke: Flags.boolean({ description: "Internal: run worker smoke without configuration or network" }),
		"owner-id": Flags.string({ description: "Internal: daemon owner id" }),
		"agent-dir": Flags.string({ description: "Internal: daemon state directory" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Daemon);
		const rawAction = args.action ?? "status";
		const positional = Array.isArray(args.kind) ? args.kind : args.kind ? [args.kind] : [];
		const flagRec = flags as Record<string, unknown>;
		const gracefulTimeoutMs = parsePositiveTimeout(
			flagRec["graceful-timeout-ms"] as string | undefined,
			"--graceful-timeout-ms",
		);
		const killTimeoutMs = parsePositiveTimeout(flagRec["kill-timeout-ms"] as string | undefined, "--kill-timeout-ms");
		const action = (resolveDaemonAction(rawAction) ?? rawAction) as DaemonCommandAction;
		const kinds = positional as DaemonKind[];
		const cmd: DaemonCommandArgs = {
			action,
			kinds,
			all: Boolean(flags.all),
			json: Boolean(flags.json),
			force: Boolean(flags.force),
			verbose: Boolean(flags.verbose),
			gracefulTimeoutMs,
			killTimeoutMs,
			spawnIfStopped: flagRec["spawn-if-stopped"] as boolean | undefined,
			smoke: Boolean(flags.smoke),
			ownerId: flagRec["owner-id"] as string | undefined,
			agentDir: flagRec["agent-dir"] as string | undefined,
		};

		if (!isDaemonInternalAction(action)) await initTheme();
		await runDaemonCommand(cmd);
	}
}
