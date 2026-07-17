/**
 * Manage GJC background daemons (status/list/stop/reload).
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import {
	type DaemonCommandAction,
	type DaemonCommandArgs,
	isDaemonInternalAction,
	runDaemonCommand,
} from "../cli/daemon-cli";
import type { DaemonKind } from "../daemon/control-types";
import { DAEMON_ACTION_TOKENS, resolveDaemonAction } from "../daemon/operator-contract";
import { initTheme } from "../modes/theme/theme";
import { runSdkSessionCli } from "../sdk/cli";

const ACTIONS = [...DAEMON_ACTION_TOKENS, "discord-internal", "slack-internal", "session"] as const;

export default class Daemon extends Command {
	static description =
		"Manage GJC background daemons and SDK sessions. Routine use: `gjc daemon status` to check, `gjc daemon restart` to reload (spawns one if none is running). `stop`/`list` and the escalation flags below are advanced primitives.";

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
		"graceful-timeout-ms": Flags.integer({ description: "Cooperative stop timeout before escalation" }),
		"kill-timeout-ms": Flags.integer({ description: "Wait for old pid death after SIGKILL" }),
		"spawn-if-stopped": Flags.boolean({ description: "On reload, spawn even when no daemon is running" }),
		smoke: Flags.boolean({ description: "Internal: run worker smoke without configuration or network" }),
		"owner-id": Flags.string({ description: "Internal: daemon owner id" }),
		"agent-dir": Flags.string({ description: "Internal: daemon state directory" }),
		op: Flags.string({ description: "SDK control or global operation" }),
		"idempotency-key": Flags.string({ description: "Caller idempotency key required for SDK lifecycle globals" }),
		"json-input": Flags.string({ description: "SDK request JSON object" }),
		"json-input-file": Flags.string({ description: "Read SDK request JSON from a 0600 file" }),
		"json-input-stdin": Flags.boolean({ description: "Read SDK request JSON from standard input" }),
		confirm: Flags.boolean({ description: "Confirm a destructive SDK control operation" }),
		query: Flags.string({ description: "SDK query name" }),
		cursor: Flags.string({ description: "SDK query continuation cursor" }),
		"show-endpoint-credential": Flags.boolean({ description: "Allow session.get_endpoint secret output" }),
		yes: Flags.boolean({ description: "Confirm endpoint credential output on a TTY" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Daemon);
		const rawAction = args.action ?? "status";
		const positional = Array.isArray(args.kind) ? args.kind : args.kind ? [args.kind] : [];
		const flagRec = flags as Record<string, unknown>;
		if (rawAction === "session") {
			await runSdkSessionCli({
				action: positional[0],
				sessionId: positional[1],
				operation: flagRec.op as string | undefined,
				query: flagRec.query as string | undefined,
				jsonInput: flagRec["json-input"] as string | undefined,
				jsonInputFile: flagRec["json-input-file"] as string | undefined,
				jsonInputStdin: Boolean(flagRec["json-input-stdin"]),
				confirm: Boolean(flagRec.confirm),
				idempotencyKey: flagRec["idempotency-key"] as string | undefined,
				cursor: flagRec.cursor as string | undefined,
				showEndpointCredential: Boolean(flagRec["show-endpoint-credential"]),
				yes: Boolean(flagRec.yes),
				agentDir: flagRec["agent-dir"] as string | undefined,
			});
			return;
		}
		const action = (resolveDaemonAction(rawAction) ?? rawAction) as DaemonCommandAction;
		const kinds = positional as DaemonKind[];
		const cmd: DaemonCommandArgs = {
			action,
			kinds,
			all: Boolean(flags.all),
			json: Boolean(flags.json),
			force: Boolean(flags.force),
			verbose: Boolean(flags.verbose),
			gracefulTimeoutMs: flagRec["graceful-timeout-ms"] as number | undefined,
			killTimeoutMs: flagRec["kill-timeout-ms"] as number | undefined,
			spawnIfStopped: flagRec["spawn-if-stopped"] as boolean | undefined,
			smoke: Boolean(flags.smoke),
			ownerId: flagRec["owner-id"] as string | undefined,
			agentDir: flagRec["agent-dir"] as string | undefined,
		};

		if (!isDaemonInternalAction(action)) await initTheme();
		await runDaemonCommand(cmd);
	}
}
