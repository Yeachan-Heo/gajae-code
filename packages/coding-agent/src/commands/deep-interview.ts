import { Command, Flags } from "@gajae-code/utils/cli";
import { ensureWorkflowSettingsMigrated } from "../config/settings";
import { runNativeDeepInterviewCommand } from "../gjc-runtime/deep-interview-runtime";

export default class DeepInterview extends Command {
	static description = `Run native GJC deep-interview workflow.

All deep-interview state operations go through this command — no gjc state needed:
  read                Print the persisted envelope, revision, content sha, and any pending draft
  write               One-shot incremental JSON merge into state (--reset replaces; the locked
                      intent contract survives a reset)
  stage               Stage one JSON transition draft (--for <transition> --input '<json>'|@file)
  check               Dry-run the staged draft against current state (same merge apply performs)
  apply               Commit the staged draft with runtime-owned revision+sha CAS
  discard             Remove the pending draft
  clear               Clear deep-interview state for the session (lifecycle passthrough)
  handoff             Hand off to the next workflow skill (lifecycle passthrough)
  --crystallize       Promote a bounded conversation snapshot into a versioned Crystal

Ambiguity is runtime-owned: apply/write derive current_ambiguity from the latest valid scored
round and clamp it to the deterministic floor. Sessions resolve from --session-id, payload
session_id, or GJC_SESSION_ID.`;
	static strict = false;
	static flags = {
		quick: Flags.boolean({ description: "Seed a quick deep-interview run" }),
		standard: Flags.boolean({ description: "Seed a standard deep-interview run" }),
		deep: Flags.boolean({ description: "Seed a deep deep-interview run" }),
		crystallize: Flags.boolean({ description: "Crystallize a bounded conversation snapshot into a versioned spec" }),
		trace: Flags.boolean({ description: "Run a bounded trace evidence pre-step before interview questions" }),
		threshold: Flags.string({ description: "Override ambiguity threshold for kickoff" }),
		"threshold-source": Flags.string({ description: "Describe the threshold override source" }),
		"session-id": Flags.string({
			description: "Route state/spec handoff through a session-scoped .gjc/_session-{sessionid} directory",
		}),
		input: Flags.string({ description: "JSON payload (or @file) for the write/stage verbs" }),
		for: Flags.string({
			description: "Transition for stage: initialize-context | record-round | update-facts | merge-state",
		}),
		reset: Flags.boolean({ description: "With write: replace state instead of incremental merge" }),
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
		'$ gjc deep-interview --trace --standard "<idea>"',
		"$ gjc deep-interview read --json",
		'$ gjc deep-interview write --input \'{"state":{"threshold":0.05}}\' --json',
		'$ gjc deep-interview stage --for record-round --input \'{"state":{"rounds":[{"round":1,"round_key":"r1"}]}}\' --json',
		"$ gjc deep-interview check --json",
		"$ gjc deep-interview apply --json",
		"$ gjc deep-interview --write --stage final --slug my-feature --spec ./final-spec.md",
		"$ gjc deep-interview --write --stage final --slug my-feature --spec ./final-spec.md --deliberate",
		"$ gjc deep-interview --crystallize --input @conversation.json --slug my-feature --json",
	];

	async run(): Promise<void> {
		await ensureWorkflowSettingsMigrated(process.cwd());
		const result = await runNativeDeepInterviewCommand(this.argv, process.cwd());
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
