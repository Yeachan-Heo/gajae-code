import { Command, Flags } from "@gajae-code/utils/cli";
import { runNativeDeepInterviewCommand } from "../gjc-runtime/deep-interview-runtime";

export default class DeepInterview extends Command {
	static description =
		"Run native GJC deep-interview workflow. Use `draft` for editable CLI-owned mutation inputs; JSON repair verbs are compatibility-only.";
	static strict = false;
	static flags = {
		quick: Flags.boolean({ description: "Seed a quick deep-interview run" }),
		standard: Flags.boolean({ description: "Seed a standard deep-interview run" }),
		deep: Flags.boolean({ description: "Seed a deep deep-interview run" }),
		trace: Flags.boolean({ description: "Run a bounded trace evidence pre-step before interview questions" }),
		threshold: Flags.string({ description: "Override ambiguity threshold for kickoff" }),
		"threshold-source": Flags.string({ description: "Describe the threshold override source" }),
		"session-id": Flags.string({
			description: "Route state/spec handoff through a session-scoped .gjc/_session-{sessionid} directory",
		}),
		write: Flags.boolean({ description: "Persist a final deep-interview spec through the sanctioned GJC CLI/API" }),
		stage: Flags.string({ description: 'Spec stage for --write (currently "final")' }),
		slug: Flags.string({ description: "Safe slug for .gjc/_session-{sessionid}/specs/deep-interview-<slug>.md" }),
		spec: Flags.string({ description: "Final spec markdown or a path to the final spec markdown" }),
		handoff: Flags.string({ description: 'After --write, hand off to a workflow target (currently "ralplan")' }),
		deliberate: Flags.boolean({
			description: "Shortcut for --write handoff to ralplan in deliberate consensus mode",
		}),
		force: Flags.boolean({ description: "Overwrite corrupt existing deep-interview state during --write" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};
	static examples = [
		'$ gjc deep-interview --trace --standard "<idea>" --json',
		"$ gjc deep-interview draft create --for initialize-context --session-id <id> --json",
		"$ gjc deep-interview draft edit --draft-id <id> --expected-draft-revision 1 --op set --path /type --value greenfield --json",
		"$ gjc deep-interview draft check --draft-id <id> --json",
		"$ gjc deep-interview initialize-context --draft-id <id> --expected-draft-revision <n> --json",
		"$ gjc deep-interview --write --stage final --slug my-feature --spec ./final-spec.md --json",
		"$ gjc deep-interview inspect --session-id <id> --selector summary --json",
	];

	async run(): Promise<void> {
		const result = await runNativeDeepInterviewCommand(this.argv, process.cwd());
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
