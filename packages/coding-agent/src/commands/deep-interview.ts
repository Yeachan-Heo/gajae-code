import { Command, Flags } from "@gajae-code/utils/cli";
import { ensureWorkflowSettingsMigrated } from "../config/settings";
import { runNativeDeepInterviewCommand } from "../gjc-runtime/deep-interview-runtime";

export default class DeepInterview extends Command {
	static description = `Run native GJC deep-interview workflow.

All deep-interview state operations go through this command — no gjc state needed:
  read                Print the persisted envelope, revision, content sha, and any pending draft
  write               One-shot incremental JSON merge into state; required --input '<json>'|@file
                      must use the {"state":{...}} shape (--reset replaces; the locked intent
                      contract survives a reset)
  kickoff             Seed an interviewing session; --trace and --json are supported alongside
                      --quick|--standard|--deep
  write-spec          Persist a final spec through --write; --force only overwrites corrupt state
  stage               Stage one JSON transition draft; required --for <transition> and --input
                      '<json>'|@file use the {"state":{...}} shape
  check               Dry-run the staged draft against current state (same merge apply performs)
  apply               Commit the staged draft with runtime-owned revision+sha CAS
  discard             Remove the pending draft
  clear               Clear deep-interview state for the session (lifecycle passthrough)
  approve-execution   Record the user's separate, explicit approval for a ready canonical Crystal
  handoff             Hand off to the next workflow skill (lifecycle passthrough)
  --crystallize       Promote a bounded authenticated conversation snapshot into a versioned
                      Crystal; required --input '<crystallize JSON>'|@file and --slug <slug>

Crystallize input must be a JSON object with these required fields (optional prior, removed_ids,
resolved_open_gaps, resolved_conflicts, and their anchors may extend the object):
  {"snapshot":{"revision":N,"start":N,"end":N,"digest":"<sha256>","messages":[...]},
   "current_revision":N,"items":[{"id":"...","kind":"goal|constraint|decision|acceptance_criterion|non_goal",
   "classification":"confirmed|inferred|disputed","statement":"...","anchor":{"message_index":N,"quote":"..."}}],
   "open_gaps":[],"conflicts":[]}
Confirmed items require a verbatim user anchor; inferred/disputed items must not be treated as
confirmed. The raw --input payload is bounded to 1 MiB; items are capped at 128 and each text
field at 10,000 characters, and snapshot messages must be contiguous, ordered, and cover
start..end (maximum 200 messages). The
digest/current_revision must match the live authenticated transcript. A ready Crystal persists as
deep-interview-<slug>-v<spec_version>.md;
needs-questions, stale, or superseded Crystal input does not publish a spec. Crystallize always
leaves execution_approval as not-approved; approve-execution is a separate explicit transition.

Ambiguity is runtime-owned: apply/write derive current_ambiguity from the latest valid scored
round and clamp it to the deterministic floor. Sessions resolve from --session-id, payload
session_id, or GJC_SESSION_ID. A relative GJC_SESSION_FILE is resolved against the requested
workspace cwd, never the process launch directory.`;
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
		input: Flags.string({
			description:
				'Required JSON object (or @file): generic api uses --input; write/stage use {"state":{...}}; crystallize uses snapshot/current_revision/items; payload <=1 MiB',
		}),
		for: Flags.string({
			description: "Transition for stage: initialize-context | record-round | update-facts | merge-state",
		}),
		reset: Flags.boolean({ description: "With write: replace state instead of incremental merge" }),
		write: Flags.boolean({
			description:
				"Persist a final deep-interview spec through the sanctioned GJC CLI/API (requires --spec; positional write requires --input)",
		}),
		stage: Flags.string({ description: 'Spec stage for --write (currently "final")' }),
		slug: Flags.string({
			description:
				"Required with --crystallize; safe slug for .gjc/_session-{sessionid}/specs/deep-interview-<slug>.md",
		}),
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
		'$ gjc deep-interview --trace --standard "<idea>" --json',
		"$ gjc deep-interview read --json",
		'$ gjc deep-interview write --input \'{"state":{"threshold":0.05,"threshold_source":"default"}}\' --json',
		'$ gjc deep-interview stage --for record-round --input \'{"state":{"rounds":[{"round":1,"round_key":"r1"}]}}\' --json',
		"$ gjc deep-interview check --json",
		"$ gjc deep-interview apply --json",
		"$ gjc deep-interview approve-execution --json",
		"$ gjc deep-interview --write --stage final --slug my-feature --spec ./final-spec.md",
		"$ gjc deep-interview --write --stage final --slug my-feature --spec ./final-spec.md --force",
		"$ gjc deep-interview --write --stage final --slug my-feature --spec ./final-spec.md --deliberate",
		'$ gjc deep-interview --crystallize --input \'{"snapshot":{"revision":1,"start":0,"end":0,"digest":"<64-hex-sha256>","messages":[{"index":0,"role":"user","content":"Build audit reports"}]},"current_revision":1,"items":[{"id":"goal:reports","kind":"goal","classification":"confirmed","statement":"Build audit reports","anchor":{"message_index":0,"quote":"Build audit reports"}}],"open_gaps":[],"conflicts":[]}\' --slug audit-reports --json',
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
