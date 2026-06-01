import { Command, Flags } from "@gajae-code/utils/cli";
import { runNativeDeepInterviewCommand } from "../gjc-runtime/deep-interview-runtime";

export default class DeepInterview extends Command {
	static description = "Run native GJC deep-interview workflow";
	static strict = false;
	static flags = {
		quick: Flags.boolean({ description: "Seed a quick deep-interview run" }),
		standard: Flags.boolean({ description: "Seed a standard deep-interview run" }),
		deep: Flags.boolean({ description: "Seed a deep deep-interview run" }),
		threshold: Flags.string({ description: "Override ambiguity threshold for kickoff" }),
		"threshold-source": Flags.string({ description: "Describe the threshold override source" }),
		"session-id": Flags.string({
			description: "Route state/spec handoff through a session-scoped .gjc state directory",
		}),
		write: Flags.boolean({ description: "Persist a final deep-interview spec through the sanctioned GJC CLI/API" }),
		stage: Flags.string({ description: 'Spec stage for --write (currently "final")' }),
		slug: Flags.string({ description: "Safe slug for .gjc/specs/deep-interview-<slug>.md" }),
		spec: Flags.string({ description: "Final spec markdown or a path to the final spec markdown" }),
		handoff: Flags.string({ description: 'After --write, hand off to a workflow target (currently "ralplan")' }),
		deliberate: Flags.boolean({
			description: "Shortcut for --write handoff to ralplan in deliberate consensus mode",
		}),
		json: Flags.boolean({ description: "Output JSON" }),
	};
	static examples = [
		'$ gjc deep-interview --standard "<idea>"',
		"$ gjc deep-interview --write --stage final --slug my-feature --spec ./final-spec.md",
		"$ gjc deep-interview --write --stage final --slug my-feature --spec ./final-spec.md --deliberate",
	];

	async run(): Promise<void> {
		const result = await runNativeDeepInterviewCommand(this.argv, process.cwd());
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
