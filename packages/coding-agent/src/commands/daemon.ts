/** Manage public daemon operations while keeping worker grammar private. */
import {
	type ArgDescriptor,
	Args,
	CliParseError,
	Command,
	type FlagDescriptor,
	Flags,
	type ParseOutput,
} from "@gajae-code/utils/cli";
import {
	type DaemonCommandAction,
	type DaemonCommandArgs,
	isDaemonInternalAction,
	runDaemonCommand,
} from "../cli/daemon-cli";
import { PublicCommandFailure } from "../cli/public-command-errors";
import { getPublicCommand } from "../cli/public-command-registry";
import type { DaemonKind } from "../daemon/control-types";
import { resolveDaemonAction } from "../daemon/operator-contract";
import { initTheme } from "../modes/theme/theme";

export default class Daemon extends Command {
	static description = getPublicCommand(["daemon"])!.description;
	static args: Record<string, ArgDescriptor> = getPublicCommand(["daemon"])!.args;
	static flags: Record<string, FlagDescriptor> = getPublicCommand(["daemon"])!.flags;

	async run(): Promise<void> {
		const internal = isDaemonInternalAction(this.argv[0] as DaemonCommandAction);
		const resolved = resolveDaemonAction(this.argv[0]);
		const action = (internal ? this.argv[0] : (resolved ?? "status")) as DaemonCommandAction;
		const descriptor = getPublicCommand(["daemon", resolved ?? "status"])!;
		class PublicDaemonOperation extends Daemon {
			static args = { kind: { ...descriptor.args.kind!, options: undefined } };
			static flags = descriptor.flags;
		}
		const parser = internal
			? new DaemonWorker(this.argv, this.config)
			: new PublicDaemonOperation(resolved ? this.argv.slice(1) : this.argv, this.config);
		let parsed: ParseOutput;
		try {
			parsed = await parser.parse((internal ? DaemonWorker : PublicDaemonOperation) as typeof Daemon);
		} catch (error) {
			if (!internal && error instanceof CliParseError)
				throw new PublicCommandFailure({ kind: "usage", proof: "pre-effect" });
			throw error;
		}
		const { args, flags } = parsed;
		const timeout = (name: string): number | undefined => {
			const raw = flags[name];
			if (raw === undefined) return undefined;
			if (
				typeof raw !== "string" ||
				!/^[0-9]+$/.test(raw) ||
				!Number.isSafeInteger(Number(raw)) ||
				Number(raw) <= 0
			) {
				throw new PublicCommandFailure({ kind: "usage", proof: "pre-effect" });
			}
			return Number(raw);
		};
		const positional = Array.isArray(args.kind) ? args.kind : args.kind ? [args.kind] : [];
		const cmd: DaemonCommandArgs = {
			action,
			kinds: positional as DaemonKind[],
			all: Boolean(flags.all),
			json: Boolean(flags.json),
			force: Boolean(flags.force),
			verbose: Boolean(flags.verbose),
			gracefulTimeoutMs: timeout("graceful-timeout-ms"),
			killTimeoutMs: timeout("kill-timeout-ms"),
			spawnIfStopped: flags["spawn-if-stopped"] as boolean | undefined,
			smoke: Boolean(flags.smoke),
			ownerId: flags["owner-id"] as string | undefined,
			agentDir: flags["agent-dir"] as string | undefined,
		};
		if (!internal) await initTheme();
		await runDaemonCommand(cmd);
	}
}

class DaemonWorker extends Daemon {
	static args = { action: Args.string({ required: true }), kind: Args.string({ multiple: true }) };
	static flags = {
		smoke: Flags.boolean({ description: "Run worker smoke without configuration or network" }),
		"owner-id": Flags.string({ description: "Daemon owner id" }),
		"agent-dir": Flags.string({ description: "Daemon state directory" }),
	};
}
