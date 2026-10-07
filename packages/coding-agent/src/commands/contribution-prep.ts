import { Command, Flags } from "@gajae-code/utils/cli";

function writeText(lines: string[]): void {
	process.stdout.write(`${lines.join("\n")}\n`);
}

export default class ContributionPrep extends Command {
	static description = "Dump redacted context and prepare a fresh contribute-pr worker prompt";
	static strict = false;

	static flags = {
		"source-session-id": Flags.string({ description: "Source session id to record in the manifest" }),
		"artifact-root": Flags.string({ description: "Directory where contribute-pr artifacts are written" }),
	};

	static examples = ["gjc contribute-pr"];

	async run(): Promise<void> {
		const { flags } = await this.parse(ContributionPrep);
		const { prepareContributionPrep } = await import("../session/contribution-prep");
		const cwd = process.cwd();
		const result = await prepareContributionPrep(
			{
				sessionId: flags["source-session-id"] ?? "cli",
				cwd,
				messages: [],
			},
			{
				artifactRoot: flags["artifact-root"],
			},
		);
		writeText([
			"Contribution prep artifacts written.",
			`Manifest: ${result.manifestPath}`,
			`Worker prompt: ${result.workerPromptPath}`,
			`Spawned worker: ${result.spawned ? "yes" : "no"}`,
		]);
	}
}
