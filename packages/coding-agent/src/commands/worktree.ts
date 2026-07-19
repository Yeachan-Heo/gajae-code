/**
 * Report-only diagnostics for agent-managed worktrees.
 */
import { Args, Command, type CommandCtor, Flags } from "@gajae-code/utils/cli";

export type WorktreeRootGetter = () => string;

export function createWorktreeCommand(getWorktreesDir: WorktreeRootGetter): CommandCtor {
	return class Worktree extends Command {
		static description = "List report-only diagnostics for agent-managed worktrees";
		static aliases = ["wt"];

		static args = {
			action: Args.string({
				description: "list (default) or clear",
				required: false,
				options: ["list", "clear"],
				default: "list",
			}),
		};

		static flags = {
			all: Flags.boolean({ description: "Unavailable: cleanup is report-only", default: false }),
			"dry-run": Flags.boolean({ char: "n", description: "Preview the report-only clear summary", default: false }),
			json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		};

		static examples = [
			"gjc worktree",
			"gjc worktree list --json",
			"gjc worktree clear",
			"gjc worktree clear --dry-run",
		];

		async run(): Promise<void> {
			const { args, flags, argv } = await this.parse(Worktree);
			const action = args.action === "clear" ? "clear" : "list";
			const all = flags.all ?? false;
			const dryRun = flags["dry-run"] ?? false;
			const json = flags.json ?? false;
			const validPositionals = argv.length <= 1 && (argv.length === 0 || argv[0] === action);
			const valid = validPositionals && ((action === "clear" && !all) || (action === "list" && !all && !dryRun));
			if (!valid) {
				if (json) {
					process.stdout.write(
						'{"error":{"code":"worktree_cleanup_disabled","message":"worktree cleanup is report-only"}}\n',
					);
				} else {
					process.stderr.write("error: worktree cleanup is report-only\n");
				}
				process.exitCode = 2;
				return;
			}
			const root = getWorktreesDir();
			const { runWorktreeCommand } = await import("../cli/worktree-cli");
			const result = await runWorktreeCommand({
				root,
				platform: process.platform === "win32" ? "win32" : "posix",
				action,
				json,
				dryRun,
			});
			if (result.stdout.length > 0) process.stdout.write(result.stdout);
			if (result.stderr.length > 0) process.stderr.write(result.stderr);
			if (result.exitCode !== 0) process.exitCode = result.exitCode;
		}
	};
}
