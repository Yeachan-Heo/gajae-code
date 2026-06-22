/**
 * Manage GJC background daemons (status/list/stop/reload).
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { type DaemonCliAction, type DaemonCommandArgs, runDaemonCommand } from "../cli/daemon-cli";
import type { DaemonKind } from "../daemon/control-types";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: DaemonCliAction[] = ["list", "status", "stop", "reload"];

export default class Daemon extends Command {
	static description = "Manage GJC background daemons (status, list, stop, reload)";

	static args = {
		action: Args.string({ description: "Daemon action", required: false, options: ACTIONS }),
		kind: Args.string({ description: "Daemon kind(s) to target", required: false, multiple: true }),
	};

	static flags = {
		all: Flags.boolean({ description: "Target all registered daemon kinds" }),
		json: Flags.boolean({ description: "Emit JSON output" }),
		force: Flags.boolean({ description: "Allow hard-kill escalation when graceful stop times out" }),
		"graceful-timeout-ms": Flags.integer({ description: "Cooperative stop timeout before escalation" }),
		"kill-timeout-ms": Flags.integer({ description: "Wait for old pid death after SIGKILL" }),
		"spawn-if-stopped": Flags.boolean({ description: "On reload, spawn even when no daemon is running" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Daemon);
		const action = (args.action ?? "status") as DaemonCliAction;
		const kinds = (Array.isArray(args.kind) ? args.kind : args.kind ? [args.kind] : []) as DaemonKind[];
		const flagRec = flags as Record<string, unknown>;
		const cmd: DaemonCommandArgs = {
			action,
			kinds,
			all: Boolean(flags.all),
			json: Boolean(flags.json),
			force: Boolean(flags.force),
			gracefulTimeoutMs: flagRec["graceful-timeout-ms"] as number | undefined,
			killTimeoutMs: flagRec["kill-timeout-ms"] as number | undefined,
			spawnIfStopped: flagRec["spawn-if-stopped"] as boolean | undefined,
		};

		await initTheme();
		await runDaemonCommand(cmd);
	}
}
