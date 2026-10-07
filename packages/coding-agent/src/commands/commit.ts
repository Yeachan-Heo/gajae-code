/**
 * Generate and optionally push a commit with changelog updates.
 */
import { postmortem } from "@gajae-code/utils";
import { Command, Flags } from "@gajae-code/utils/cli";
import { runCommitCommand } from "../commit";
import type { CommitCommandArgs } from "../commit/types";
import { initTheme } from "../modes/theme/theme";

export default class Commit extends Command {
	static description = "Generate a commit message and update changelogs";

	static flags = {
		push: Flags.boolean({ description: "Push after committing" }),
		"dry-run": Flags.boolean({ description: "Preview without committing" }),
		"no-changelog": Flags.boolean({ description: "Skip changelog updates" }),
		legacy: Flags.boolean({ description: "Use legacy deterministic pipeline" }),
		context: Flags.string({ char: "c", description: "Additional context for the model" }),
		model: Flags.string({ char: "m", description: "Override model selection" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Commit);

		const cmd: CommitCommandArgs = {
			push: flags.push ?? false,
			dryRun: flags["dry-run"] ?? false,
			noChangelog: flags["no-changelog"] ?? false,
			legacy: flags.legacy,
			context: flags.context,
			model: flags.model,
		};

		await initTheme();
		// The agentic commit flow opens keep-alive sockets to the model
		// provider and spins up an AgentSession with
		// background async-job + extension machinery. `session.dispose()` releases
		// what it can, but Bun's fetch keeps idle connections warm and a few
		// timers (Settings autosave, OAuth refresh) stay armed long enough to
		// pin the event loop after the commit is already written. Mirror the
		// `runPrintMode` exit pattern from `main.ts` so the CLI returns to the
		// shell instead of stranding the user on Ctrl+C (issue #1041).
		await runCommitCommand(cmd);
		await postmortem.quit(0);
	}
}
