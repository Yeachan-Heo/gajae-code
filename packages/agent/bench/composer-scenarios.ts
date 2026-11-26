/**
 * Single source of truth for Composer stability V3 scenarios (prompts + obligations).
 * Live capture and the trace classifier must import from here — do not duplicate prompts.
 */

export type ScenarioId =
	| "read-edit-hashline"
	| "three-turn-tools"
	| "bash-discipline"
	| "file-discovery-discipline"
	| "shell-write-discipline"
	| "command-contamination"
	| "grok-sanitize-replay"
	| "multi-file-search-edit"
	| "multi-file-search-edit-bad-anchor"
	| "bad-anchor-recovery"
	| "tool-json-malformed-recovery"
	| "multi-turn-yield-discipline"
	| "timeout-handling"
	| "hard-guard-feedback"
	| "legitimate-bash-after-tools"
	| "wrong-target-disambiguation"
	| "malformed-edit-recovery"
	| "cost-safe-timeout";

export type FailureClass =
	| "shell-read"
	| "shell-file-discovery"
	| "shell-write"
	| "contaminated-command"
	| "bad-anchor-unrecovered"
	| "malformed-tool-args-unrecovered"
	| "sanitize-replay-regression"
	| "wrong-file-edit"
	| "missing-tool-turn"
	| "timeout";

export type ScenarioDefinition = {
	id: ScenarioId;
	description: string;
	turns: string;
	fixture: string;
	obligation: string;
	/** Frozen user prompt for live print-mode capture (composer-scenarios v1). */
	userPrompt: string;
	failureClass: FailureClass;
	recovery: boolean;
};

/** P1 anti-fake-pass: minimum comparable scenario ids (candidate + baseline). */
export const MIN_COMPARABLE_TRACE_SCENARIOS = 3;

/** Public L2 claim: minimum scenarios with both roles represented in trace corpus. */
export const L2_MIN_SCENARIO_COVERAGE = 10;

export const COMPOSER_SCENARIOS_V1_COUNT = 13;
export const TOTAL_SCENARIO_COUNT = 18;

export const COMPOSER_SCENARIOS_VERSION = "v2";

export const DEFAULT_COMPOSER_CANDIDATE_MODEL = "grok-build/grok-composer-2.5-fast";
export const DEFAULT_CODEX_BASELINE_MODEL = "openai-codex/gpt-5.5:low";

export const L3_MIN_TRIALS_PER_ARM = 3;

export type TraceExpectation = {
	targetPath?: string;
	requiredTools?: string[];
	expectedEditText?: string;
	recoveryTargetPath?: string;
	requireSuccess?: boolean;
};

export function traceExpectationForScenario(scenarioId: ScenarioId): TraceExpectation {
	switch (scenarioId) {
		case "bash-discipline":
			return { requiredTools: ["read"], requireSuccess: true };
		case "three-turn-tools":
			return {
				targetPath: "fixtures/workspace/src/a.ts",
				expectedEditText: "TARGET_MARKER_DONE",
				requiredTools: ["read", "search", "edit"],
				requireSuccess: true,
			};
		case "shell-write-discipline":
			return { targetPath: "fixtures/workspace/src/write-target.ts", expectedEditText: "42", requireSuccess: true };
		case "multi-file-search-edit":
			return {
				targetPath: "fixtures/workspace/src/pkg/alpha.ts",
				expectedEditText: "pkg-marker-patched",
				requireSuccess: true,
			};
		case "multi-file-search-edit-bad-anchor":
			return {
				targetPath: "fixtures/workspace/src/target.ts",
				expectedEditText: "recovered-anchor-ok",
				requireSuccess: true,
			};
		case "read-edit-hashline":
			return {
				targetPath: "fixtures/workspace/src/foo.ts",
				expectedEditText: "hello-composer-harness",
				requireSuccess: true,
			};
		case "bad-anchor-recovery":
			return { targetPath: "fixtures/workspace/src/recover.ts", expectedEditText: "ok", requireSuccess: true };
		case "multi-turn-yield-discipline":
			return { targetPath: "fixtures/workspace/src/multi.ts", expectedEditText: "-done", requireSuccess: true };
		case "hard-guard-feedback":
			return {
				recoveryTargetPath: "fixtures/workspace/src/policy-secret.ts",
				requiredTools: ["bash", "read"],
				requireSuccess: true,
			};
		case "legitimate-bash-after-tools":
			return { requiredTools: ["find", "read", "bash"], requireSuccess: true };
		case "wrong-target-disambiguation":
			return {
				targetPath: "fixtures/workspace/src/disambiguation/target.ts",
				expectedEditText: "EXACT_TARGET_DONE",
				requireSuccess: true,
			};
		case "malformed-edit-recovery":
			return {
				targetPath: "fixtures/workspace/src/malformed-edit.ts",
				expectedEditText: "MALFORMED_EDIT_DONE",
				requireSuccess: true,
			};
		case "cost-safe-timeout":
			return { requiredTools: ["find", "read"], requireSuccess: true };
		default:
			return { requireSuccess: true };
	}
}

export const COMPOSER_SCENARIOS_V1_IDS = [
	"read-edit-hashline",
	"three-turn-tools",
	"bash-discipline",
	"file-discovery-discipline",
	"shell-write-discipline",
	"command-contamination",
	"grok-sanitize-replay",
	"multi-file-search-edit",
	"multi-file-search-edit-bad-anchor",
	"bad-anchor-recovery",
	"tool-json-malformed-recovery",
	"multi-turn-yield-discipline",
	"timeout-handling",
] as const satisfies readonly ScenarioId[];

export const COMPOSER_SCENARIOS: ScenarioDefinition[] = [
	{
		id: "read-edit-hashline",
		description: "Read anchored file contents, then apply one hashline edit.",
		turns: "2-3",
		fixture: "fixtures/workspace/src/foo.ts",
		obligation: "final file matches golden and file IO uses read/edit tools only",
		userPrompt:
			"In this repo workspace, read fixtures/workspace/src/foo.ts with the read tool, then change the exported greeting string to exactly `hello-composer-harness` using the edit tool and hashline anchors from your read output. Do not use shell commands to read or write files.",
		failureClass: "bad-anchor-unrecovered",
		recovery: false,
	},
	{
		id: "three-turn-tools",
		description: "Chain read, search, and edit across three tool turns.",
		turns: "3+",
		fixture: "fixtures/workspace/src/{a,b}.ts",
		obligation: "all tool calls are well-formed and final edit applies",
		userPrompt:
			"Use search to find where `TARGET_MARKER` appears under fixtures/workspace/src/, read the matching file, then edit it so `TARGET_MARKER` becomes `TARGET_MARKER_DONE`. Use find/read/search/edit only — no shell file IO.",
		failureClass: "missing-tool-turn",
		recovery: false,
	},
	{
		id: "bash-discipline",
		description: "User asks for file content; model must avoid shell reads.",
		turns: "2",
		fixture: "fixtures/workspace/src/secret.ts",
		obligation: "no bash/cat/sed/awk/grep/head/tail file reads",
		userPrompt:
			"Show me the full contents of fixtures/workspace/src/secret.ts. Use only the read tool (or search/find if needed to locate it) — never cat, sed, grep, or other shell reads.",
		failureClass: "shell-read",
		recovery: false,
	},
	{
		id: "file-discovery-discipline",
		description: "Locate candidate files without shell ls/find/fd/git-ls-files shortcuts.",
		turns: "2-3",
		fixture: "fixtures/workspace/src/**/*.ts",
		obligation: "file discovery uses the find tool, not shell directory listing commands",
		userPrompt:
			"List TypeScript files under fixtures/workspace/src using the find tool only (no shell ls, fd, git ls-files, or find in bash). Then read one of them briefly to confirm it exists.",
		failureClass: "shell-file-discovery",
		recovery: false,
	},
	{
		id: "shell-write-discipline",
		description: "Apply edits without shell redirection, tee, sed -i, or script writes.",
		turns: "2-4",
		fixture: "fixtures/workspace/src/write-target.ts",
		obligation: "all file mutation uses edit/write tool calls only",
		userPrompt:
			"Update fixtures/workspace/src/write-target.ts so the constant VALUE equals 42. Use read then edit/write tools only — no tee, sed -i, redirection, or python/node one-liners that write files.",
		failureClass: "shell-write",
		recovery: false,
	},
	{
		id: "command-contamination",
		description: "Keep bash command arguments free of reasoning prose and Markdown fences.",
		turns: "2",
		fixture: "fixtures/transcripts/command-contamination/*.json",
		obligation: "shell command strings contain commands only, not analysis text",
		userPrompt:
			"Run `bun test` in packages/agent if present, or `true` if not. If you use bash, the command string must be only the command — no markdown fences or explanatory prose inside the command argument.",
		failureClass: "contaminated-command",
		recovery: false,
	},
	{
		id: "grok-sanitize-replay",
		description: "Replay grok-cli payload sanitize edge cases.",
		turns: "2-4",
		fixture: "fixtures/transcripts/grok-sanitize-replay/*.json",
		obligation: "sanitized replay preserves discipline and tool pairing",
		userPrompt:
			"Read packages/agent/test/fixtures/composer-stability-v3/traces/parity.json (first 40 lines) with the read tool and summarize whether tool events look paired. Use read/search only for file content.",
		failureClass: "sanitize-replay-regression",
		recovery: true,
	},
	{
		id: "multi-file-search-edit",
		description: "Search multiple files, choose the right target, then edit.",
		turns: "3-5",
		fixture: "fixtures/workspace/src/pkg/*",
		obligation: "correct file chosen and patched",
		userPrompt:
			"Search for `pkg-marker-alpha` under fixtures/workspace/src/pkg, pick the correct file, read it, and change `pkg-marker-alpha` to `pkg-marker-patched` with edit. Do not use shell grep or sed.",
		failureClass: "wrong-file-edit",
		recovery: false,
	},
	{
		id: "multi-file-search-edit-bad-anchor",
		description: "Recover from a stale anchor after multi-file search.",
		turns: "3-6",
		fixture: "fixtures/workspace/src/target.ts",
		obligation: "first edit fails predictably, re-read occurs, second edit succeeds",
		userPrompt:
			"Read fixtures/workspace/src/target.ts, attempt a one-line edit using anchors from read, and if edit rejects anchors, re-read and retry with fresh anchors until the line contains `recovered-anchor-ok`.",
		failureClass: "bad-anchor-unrecovered",
		recovery: true,
	},
	{
		id: "bad-anchor-recovery",
		description: "Recover from a stale anchor in a single-file edit.",
		turns: "3-5",
		fixture: "fixtures/workspace/src/recover.ts",
		obligation: "failed edit is followed by re-anchor read and successful edit",
		userPrompt:
			"Edit fixtures/workspace/src/recover.ts to set STATUS to `ok` using hashline edit. If anchors mismatch, use the rejection message's fresh anchors or re-read before retrying.",
		failureClass: "bad-anchor-unrecovered",
		recovery: true,
	},
	{
		id: "tool-json-malformed-recovery",
		description: "Recover after one malformed tool-argument payload.",
		turns: "2-4",
		fixture: "fixtures/transcripts/tool-json-malformed-recovery/*.json",
		obligation: "malformed args are corrected with a valid follow-up call",
		userPrompt:
			"Read fixtures/workspace/src/foo.ts with a valid read tool call (path only in arguments). If a tool call fails validation, immediately retry with strict JSON schema args.",
		failureClass: "malformed-tool-args-unrecovered",
		recovery: true,
	},
	{
		id: "multi-turn-yield-discipline",
		description: "Maintain file IO discipline across a longer multi-turn session.",
		turns: "4+",
		fixture: "fixtures/workspace/src/multi.ts",
		obligation: "no shell reads across turns and task completes",
		userPrompt:
			"In up to four tool turns: find fixtures/workspace/src/multi.ts, read it, search for `MULTI_TURN` in that file, and edit to append `-done` to that token. Never use shell to read files across turns.",
		failureClass: "shell-read",
		recovery: false,
	},
	{
		id: "timeout-handling",
		description: "Detect turn/run timeouts as first-class instability failures.",
		turns: "1+",
		fixture: "fixtures/transcripts/timeout/*.json",
		obligation: "deadline or timeout failures count against parity instead of being ignored",
		userPrompt:
			"Read docs/composer-codex-parity.md (first 30 lines) with read tool and confirm the V3 trace gate section exists. Use read only — complete promptly without long-running shell.",
		failureClass: "timeout",
		recovery: false,
	},
	{
		id: "hard-guard-feedback",
		description: "Recover correctly after Composer bash policy blocks shell file IO.",
		turns: "2-4",
		fixture: "fixtures/workspace/src/policy-secret.ts",
		obligation: "intentional blocked bash file IO is followed by read-tool recovery without shell retry",
		userPrompt:
			"First intentionally try to read fixtures/workspace/src/policy-secret.ts with bash `cat fixtures/workspace/src/policy-secret.ts` to exercise the Composer bash policy. When that is blocked, recover by using the read tool; do not retry another shell file IO command.",
		failureClass: "shell-read",
		recovery: true,
	},
	{
		id: "legitimate-bash-after-tools",
		description: "Use dedicated tools for file IO, then a legitimate terminal command.",
		turns: "3-5",
		fixture: "fixtures/workspace/src/bash-ok.ts",
		obligation: "file IO uses find/read and bash is limited to an allowlisted terminal operation",
		userPrompt:
			"Find and read fixtures/workspace/src/bash-ok.ts using dedicated tools, then run `git status --short --branch` with bash. Do not inspect files through bash.",
		failureClass: "shell-read",
		recovery: false,
	},
	{
		id: "wrong-target-disambiguation",
		description: "Disambiguate near-identical targets before editing.",
		turns: "3-5",
		fixture: "fixtures/workspace/src/disambiguation/*",
		obligation: "only the file containing EXACT_TARGET is edited; decoy files remain untouched",
		userPrompt:
			"Search fixtures/workspace/src/disambiguation for `EXACT_TARGET`, read the matching file, and edit only that file so `EXACT_TARGET` becomes `EXACT_TARGET_DONE`. Do not modify decoys.",
		failureClass: "wrong-file-edit",
		recovery: false,
	},
	{
		id: "malformed-edit-recovery",
		description: "Recover from malformed edit arguments without switching tool families.",
		turns: "3-5",
		fixture: "fixtures/workspace/src/malformed-edit.ts",
		obligation: "malformed edit args are followed by a valid edit on the same target",
		userPrompt:
			"Read fixtures/workspace/src/malformed-edit.ts and change `MALFORMED_EDIT_PENDING` to `MALFORMED_EDIT_DONE` with edit. If an edit call fails validation, retry with strict edit schema arguments and do not use bash.",
		failureClass: "malformed-tool-args-unrecovered",
		recovery: true,
	},
	{
		id: "cost-safe-timeout",
		description: "Avoid long-running or repeated expensive terminal work.",
		turns: "1-2",
		fixture: "fixtures/transcripts/cost-safe-timeout/*.json",
		obligation: "no long-running shell loops; use find/read and finish promptly",
		userPrompt:
			"Confirm whether fixtures/transcripts/cost-safe-timeout/sample.json exists using find/read. Do not run sleep loops, watchers, or broad live commands.",
		failureClass: "timeout",
		recovery: false,
	},
];

export const SCENARIO_BY_ID = new Map(COMPOSER_SCENARIOS.map(scenario => [scenario.id, scenario]));

export function composerScenariosForVersion(version: string | undefined): ScenarioDefinition[] {
	if (version === "v1") {
		const v1Ids = new Set<ScenarioId>(COMPOSER_SCENARIOS_V1_IDS);
		return COMPOSER_SCENARIOS.filter(scenario => v1Ids.has(scenario.id));
	}
	return COMPOSER_SCENARIOS;
}

export function composerScenarioCountForVersion(version: string | undefined): number {
	return composerScenariosForVersion(version).length;
}
