import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import {
	activeSnapshotPath,
	modeStatePath,
	sessionStateDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import {
	assertWorkflowMutationRawPathsAllowed,
	DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE,
	getWorkflowMutationDecision,
	RALPLAN_MUTATION_BLOCK_MESSAGE,
	readWorkflowGuardContext,
	ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE,
} from "@gajae-code/coding-agent/skill-state/workflow-mutation-guard";
import { ToolError } from "@gajae-code/coding-agent/tools/tool-errors";
import { logger } from "@gajae-code/utils";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-guard-"));
	tempRoots.push(root);
	return root;
}

async function writeActiveDeepInterview(cwd: string, sessionId = "session-a", phase = "interviewing"): Promise<void> {
	const now = new Date().toISOString();
	const sessionDir = sessionStateDir(cwd, sessionId);
	await fs.mkdir(sessionDir, { recursive: true });
	const activeState = {
		version: 1,
		active: true,
		skill: "deep-interview",
		phase,
		updated_at: now,
		active_skills: [
			{
				skill: "deep-interview",
				phase,
				active: true,
				updated_at: now,
				session_id: sessionId,
			},
		],
	};
	await Bun.write(activeSnapshotPath(cwd, sessionId), `${JSON.stringify(activeState, null, 2)}\n`);
	await Bun.write(
		modeStatePath(cwd, sessionId, "deep-interview"),
		`${JSON.stringify({ active: true, current_phase: phase, session_id: sessionId }, null, 2)}\n`,
	);
}

async function writeActiveSkill(
	cwd: string,
	skill: "deep-interview" | "ralplan" | "ultragoal" | "team",
	phase: string,
	sessionId = "session-a",
): Promise<void> {
	const now = new Date().toISOString();
	const sessionDir = sessionStateDir(cwd, sessionId);
	await fs.mkdir(sessionDir, { recursive: true });
	const activeState = {
		version: 1,
		active: true,
		skill,
		phase,
		updated_at: now,
		active_skills: [{ skill, phase, active: true, updated_at: now, session_id: sessionId }],
	};
	await Bun.write(activeSnapshotPath(cwd, sessionId), `${JSON.stringify(activeState, null, 2)}\n`);
	await Bun.write(
		modeStatePath(cwd, sessionId, skill),
		`${JSON.stringify({ active: true, current_phase: phase, session_id: sessionId }, null, 2)}\n`,
	);
}

function tool(name: string, extra: Record<string, unknown> = {}): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		...extra,
	} as AgentTool;
}

function parseStateCommandJson(stdout: string | undefined): Record<string, unknown> {
	if (!stdout) throw new Error("missing state command stdout");
	return JSON.parse(stdout) as Record<string, unknown>;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("workflow mutation guard", () => {
	it("reuses one workflow guard context across mutation decisions", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);
		const context = await readWorkflowGuardContext(cwd, { sessionId: "session-a" });

		const decisions = await Promise.all(
			["src/one.ts", "src/two.ts"].map(path =>
				getWorkflowMutationDecision({
					cwd,
					sessionId: "session-a",
					tool: tool("write"),
					args: { path, content: "x" },
					guardContext: context,
				}),
			),
		);

		expect(context.modeStates.get("deep-interview")?.current_phase).toBe("interviewing");
		expect(decisions.map(decision => decision.blocked)).toEqual([true, true]);
	});
	it("blocks product write/edit/ast_edit targets while deep-interview is active", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const [name, args, extra = {}] of [
			["write", { path: "packages/coding-agent/src/foo.ts", content: "x" }],
			["edit", { path: "src/foo.ts", edits: [{ old_text: "a", new_text: "b" }] }],
			[
				"edit",
				{ input: "*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-a\n+b\n*** End Patch\n" },
				{ mode: "apply_patch", customWireName: "apply_patch" },
			],
			["ast_edit", { paths: ["packages/**"], ops: [{ pat: "foo", out: "bar" }] }],
		] as const) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool(name, extra),
				args,
			});
			expect(decision.blocked).toBe(true);
			expect(decision.reason).toBe("phase-boundary");
			expect(decision.message).toBe(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
			expect(decision.message).toContain("handoff/spec before code edits");
		}
	});

	it("blocks direct planning artifact tools and canonical workflow state targets", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const rawPath of [".gjc/specs/deep-interview-x.md", ".gjc/plans/plan.md"]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: rawPath, content: "x" },
			});
			expect(decision.blocked).toBe(true);
			expect(decision.reason).toBe("gjc-target");
			expect(decision.message).toContain("runtime-owned");
		}

		const blockedCases: Array<[string, AgentTool, unknown]> = [
			["write active", tool("write"), { path: ".gjc/state/skill-active-state.json", content: "{}" }],
			[
				"write session active legacy",
				tool("write"),
				{ path: ".gjc/state/sessions/session-a/skill-active-state.json", content: "{}" },
			],
			[
				"write session active generated",
				tool("write"),
				{ path: ".gjc/_session-session-a/state/skill-active-state.json", content: "{}" },
			],
			...(["deep-interview", "ralplan", "ultragoal", "team"] as const).map(
				skill =>
					[
						`write ${skill}`,
						tool("write"),
						{ path: `.gjc/state/sessions/session-a/${skill}-state.json`, content: "{}" },
					] as [string, AgentTool, unknown],
			),
			...(["deep-interview", "ralplan", "ultragoal", "team"] as const).map(
				skill =>
					[
						`write generated ${skill}`,
						tool("write"),
						{ path: `.gjc/_session-session-a/state/${skill}-state.json`, content: "{}" },
					] as [string, AgentTool, unknown],
			),
			[
				"apply_patch state",
				tool("edit", { mode: "apply_patch", customWireName: "apply_patch" }),
				{
					input: "*** Begin Patch\n*** Update File: .gjc/state/team-state.json\n@@\n-a\n+b\n*** End Patch\n",
				},
			],
			[
				"vim state",
				tool("edit", { mode: "vim" }),
				{ file: "src/foo.ts", steps: [{ kbd: [":edit .gjc/state/sessions/session-a/ralplan-state.json<CR>"] }] },
			],
			[
				"ast_edit state",
				tool("ast_edit"),
				{ paths: [".gjc/state/**/team-state.json"], ops: [{ pat: "foo", out: "bar" }] },
			],
		];

		for (const [, targetTool, args] of blockedCases) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: targetTool,
				args,
			});
			expect(decision.blocked).toBe(true);
			if (decision.reason === "workflow-state-target" || decision.reason === "gjc-target") {
				expect(decision.message).toContain("runtime-owned");
			} else {
				expect(decision.message).toBe(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
			}
		}
	});

	it("allows neutral temp scratch but blocks in-project / non-temp writes during active deep-interview", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		// Neutral temp scratch outside the project tree stays writable so specs can be
		// staged and fed to `gjc deep-interview --write --spec <path>`.
		for (const rawPath of [path.join(os.tmpdir(), "deep-interview-scratch.md"), "/tmp/deep-interview-scratch.md"]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: rawPath, content: "x" },
			});
			expect(decision.blocked).toBe(false);
		}

		// In-project and unresolvable targets remain blocked at the phase boundary.
		for (const rawPath of ["agent://123", "product/archive.zip:product.ts", "data.sqlite:rows:1", "src/product.ts"]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: rawPath, content: "x" },
			});
			expect(decision.blocked).toBe(true);
			expect(decision.message).toBe(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
		}

		for (const rawPath of [".gjc/specs-evil/plan.md", ".gjc/stateful/data.json"]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: rawPath, content: "x" },
			});
			expect(decision.blocked).toBe(true);
			expect(decision.message).toContain("runtime-owned");
		}

		const mixed = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("ast_edit"),
			args: { paths: [".gjc/state/deep-interview-state.json", "packages/**"], ops: [{ pat: "foo", out: "bar" }] },
		});
		expect(mixed.blocked).toBe(true);
	});

	it("allows read-only bash during active deep-interview when no mutation target is extracted", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const command of [
			"git status --short",
			"rg deep-interview packages/coding-agent/src",
			"cat packages/coding-agent/package.json",
			"sed -n '1,80p' packages/coding-agent/src/skill-state/workflow-mutation-guard.ts",

			"bun test packages/coding-agent/test/workflow-mutation-guard.test.ts",
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(false);
			expect(decision.targets).toEqual([]);
		}
	});

	it("does not misread heredoc document bodies as mutations during active deep-interview (#false-positive)", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		// Markdown spec bodies contain `>` quotes, `a > b` prose, apostrophes, and
		// even shell-looking lines — all inert data when the heredoc feeds a data
		// consumer writing to neutral temp scratch.
		const specBody = [
			"# Spec: Memory System",
			"",
			"- retrieval: session > project > global precedence",
			"- don't hardcode `~/.gjc`; user's overrides matter",
			"| Round | Prior → New | 66.5% → 62.3% |",
			"rm -rf src is what we must never do",
			"echo x > src/product.ts (quoted example, not a command)",
		].join("\n");

		for (const command of [
			`cat > /tmp/mem-spec.md <<'SPECEOF'\n${specBody}\nSPECEOF\nwc -l /tmp/mem-spec.md`,
			`cat <<'EOF' > /tmp/plan-draft.md\n${specBody}\nEOF`,
			`tee /tmp/spec.md >/dev/null <<'DOC'\n${specBody}\nDOC`,
			`cat <<-'TABDOC' > /tmp/spec.md\n\tindented body a > b\n\tTABDOC`,
			`cat <<'CNT' | wc -l\n${specBody}\nCNT`,
			`cat <<'PIPE' | grep -c retrieval | sort\n${specBody}\nPIPE`,
			// A stray quote inside a comment must not poison cross-line quote state (Codex P2).
			`# don't trip on this apostrophe\ncat <<'CMT' > /tmp/spec.md\n${specBody}\nCMT`,
			// `#` after `)` is a comment boundary too (Codex P2).
			`(true)# don't trip here either\ncat <<'PRN' > /tmp/spec.md\n${specBody}\nPRN`,
			// A spec body DOCUMENTING a shadow definition is inert data, not a real shadow (Codex P2).
			`cat <<'SHD' > /tmp/spec.md\nexample: cat() { bash -s; } and alias cat=evil\n${specBody}\nSHD`,
			// eval/source/. in ARGUMENT position never trip the evaluated-payload fail-close (Codex P2).
			`find . -name '*.md'\ncat <<'ARG' > /tmp/spec.md\n${specBody}\nARG`,
			`echo eval source .\ncat <<'TOK' > /tmp/spec.md\n${specBody}\nTOK`,
			// `function cat` in ARGUMENT position is not a shadow declaration (Codex P2).
			`echo function cat\ncat <<'FNC' > /tmp/spec.md\n${specBody}\nFNC`,
			// `command -v eval` only DESCRIBES eval; it is not an evaluated command (Codex P2).
			`command -v eval\ncat <<'CMV' > /tmp/spec.md\n${specBody}\nCMV`,
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(false);
		}
	});

	it("still blocks heredocs that mutate product paths or execute their body", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const command of [
			// Redirect target on the OPENER line is product code — blocked regardless of body.
			"cat <<'EOF' > src/product.ts\ninert body\nEOF",
			// Script consumers keep their bodies live: mutations inside count.
			"bash <<'EOF'\nrm src/product.ts\nEOF",
			'python3 <<PY\nopen("src/product.ts", "w").write("x")\nPY',
			"patch -p1 <<'EOF'\n--- a/src/product.ts\n+++ b/src/product.ts\nEOF",
			// Unknown/non-allowlisted consumers keep their bodies live too (Codex P1).
			"awk -f - <<'EOF'\nBEGIN { x } # rm src/product.ts via body\necho x > src/product.ts\nEOF",
			// A `<<` inside a comment is not an opener; the following live line still mutates (Codex P1).
			"# <<'EOF'\nrm src/product.ts\nEOF",
			// A `<<` inside double-quoted argument data is not an opener either.
			'printf "%s" "<<\'EOF\'"\nrm src/product.ts\nEOF',
			// Escaped quotes must not re-expose a quoted `<<` as an opener (Codex P1).
			'cat "a \\" <<\'EOF\' \\" b"\nrm src/product.ts\nEOF',
			// A downstream pipe stage can execute the body even when the opener is inert (Codex P1).
			"cat <<'EOF' | bash\nrm src/product.ts\nEOF",
			"cat <<'EOF' | grep -v noop | sh\nrm src/product.ts\nEOF",
			// Escaped `|` keeps `cat` as an ARGUMENT to bash -s, not a pipe stage (Codex P1).
			"bash -s \\| cat <<'EOF'\nrm src/product.ts\nEOF",
			// A shadowed allowlisted name executes the body through its function body (Codex P1).
			"cat() { bash -s; }; cat <<'EOF'\nrm src/product.ts\nEOF",
			// `)` closing a $() substitution is a word char, so `#` stays literal and the shadow stays live (Codex P1).
			"x=$(true)#lit; cat() { bash -s; }; cat <<'EOF'\nrm src/product.ts\nEOF",
			// Arithmetic $(( )) has nested parens: depth must stay balanced (Codex P1).
			"x=$((1))#lit; cat() { bash -s; }\ncat <<'EOF'\nrm src/product.ts\nEOF",
			// eval after a reserved word is still a command position (Codex P1).
			"if eval 'cat(){ bash -s; }'; then :; fi\ncat <<'EOF'\nrm src/product.ts\nEOF",
			// `builtin`/`command` wrappers still reach the evaluated command (Codex P1).
			"builtin eval 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			"command -- eval 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			// Leading redirections precede the command word — attached or separated (Codex P1).
			"</dev/null eval 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			"< /dev/null eval 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			// Backslash-newline folds away: a split `e\`+`val` is still eval (Codex P1).
			"e\\\nval 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			// ANSI-C quoting strips the `$` during quote removal: $'eval' is eval (Codex P1).
			"$'eval' 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			// A continuation between `$` and its ANSI-C quote still yields eval (Codex P1).
			"$\\\n'eval' 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			// Locale-translated `$"…"` strips the `$` too: $"eval" is eval (Codex P1).
			"$\"eval\" 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			// A continuation between `$` and its locale-translated quote also yields eval (Codex P1).
			"$\\\n\"eval\" 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			// ANSI-C escape sequences decode at runtime — fail closed (Codex P1).
			"$'\\145val' 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			// ANSI-C opener split by a continuation still carries runtime escapes (Codex P1).
			"$\\\n'\\145val' 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			// A continuation inside double quotes still splits a command word (Codex P1).
			"\"e\\\nval\" 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			// Bash's `function name()` hybrid form is still a declaration (Codex P1).
			"function cat() { bash -s; }; cat <<'EOF'\nrm src/product.ts\nEOF",
			// Function shadows after reserved words are still declarations (Codex P1).
			"if true; then cat() { bash -s; }; fi\ncat <<'EOF'\nrm src/product.ts\nEOF",
			// A nested subshell's `)` is an operator: `#` after it comments out the fake opener (Codex P1).
			"x=$( (true)# ; cat <<'EOF'\n)\nrm src/product.ts\nEOF",
			// `case` pattern `)` desyncs the depth scanner — fail closed (Codex P1).
			"x=$(case x in x) true;; esac)#lit; cat() { bash -s; }\ncat <<'EOF'\nrm src/product.ts\nEOF",
			// eval/source can install a shadow from quoted data the syntax view blanked (Codex P1).
			"eval 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			"source /dev/stdin <<'DEF'\ncat(){ bash -s; }\nDEF\ncat <<'EOF'\nrm src/product.ts\nEOF",
			// Quoted/escaped spellings of eval must still be recognized after quote removal (Codex P1).
			"e\\val 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			"'ev'al 'cat(){ bash -s; }'; cat <<'EOF'\nrm src/product.ts\nEOF",
			// A line-continued opener hides the downstream interpreter stage (Codex P1).
			"cat <<'EOF' \\\n| bash\nrm src/product.ts\nEOF",
			// A multiline double-quoted string containing `cat <<'EOF'` is data, not an opener (Codex P1).
			"printf '%s' \"\ncat <<'EOF'\n\" > /dev/null\nrm src/product.ts\nEOF",
			// Unquoted delimiter + command substitution in body expands at runtime — fail closed.
			"cat <<EOF > /tmp/out.md\n$(rm src/product.ts)\nEOF",
			// Unterminated heredoc is unparseable — body scanned as before, mutation caught.
			"cat <<'EOF' > /tmp/out.md\necho x > src/product.ts",
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(true);
		}
	});

	it("blocks mutating bash targets during active deep-interview", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const command of [
			"rm .gjc/state/deep-interview-state.json",
			"tee src/product.ts",
			"cat <<EOF > src/product.ts\nx\nEOF",
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(true);
			expect(decision.targets.length).toBeGreaterThan(0);
		}

		for (const command of [
			"mkdir -p .gjc/specs",
			"cp source.md .gjc/specs/deep-interview-x.md",
			"cat source.md > .gjc/specs/deep-interview-x.md",
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(false);
			expect(decision.targets.length).toBeGreaterThan(0);
		}
	});

	it("allows the /dev/null sink during active deep-interview", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const command of [
			"echo hi > /dev/null",
			"echo hi 2>/dev/null",
			"grep -rn pattern src 2>/dev/null | head -5",
			"cmd >/dev/null 2>&1",
			'echo hi > "/dev/null"',
			"dd if=/dev/zero of=/dev/null",
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(false);
			expect(decision.targets).toEqual([]);
		}
	});

	it("blocks every descriptor alias during active deep-interview", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		// `/dev/stdout`, `/dev/stderr`, and `/dev/fd/<n>` all name a descriptor that `exec` can
		// rebind onto a real repository file, so none of them may be treated as a sink.
		for (const [command, expected] of [
			["echo x >/dev/fd/3", "/dev/fd/3"],
			["echo hi > /dev/stdout", "/dev/stdout"],
			["echo hi 2> /dev/stderr", "/dev/stderr"],
		] as const) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(true);
			expect(decision.targets).toContain(expected);
		}
	});

	it("blocks sink-suppression bypasses during active deep-interview", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		// Every case pairs a real write with a `/dev/null` sink: suppressing the sink must not
		// leave an empty target list that reads as "safe".
		for (const command of [
			"exec 1<>src/product.ts; printf x >/dev/stdout",
			"exec 1<>.gjc/_session-session-a/state/deep-interview-state.json; printf x >/dev/stdout",
			"/bin/dd if=/dev/zero of=src/product.ts count=1 2>/dev/null",
			"printf x | /usr/bin/tee src/product.ts >/dev/null",
			"dd if=/dev/zero of=/dev/null of=src/product.ts count=1",
			"printf x >|src/product.ts 2>/dev/null",
			"printf x >&src/product.ts 2>/dev/null",
			"printf x >|.gjc/_session-session-a/state/deep-interview-state.json 2>/dev/null",
			'dd if=/dev/zero of=" /dev/null"',
			'printf x >" src.ts"',
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(true);
		}
	});

	it("keeps project, .gjc, mixed, dd, and exact-match-negative targets blocked", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const command of [
			"echo x > src/product.ts",
			"echo x > .gjc/_session-test/state/deep-interview-state.json",
			"echo hi > /dev/null; touch src/product.ts",
			"dd if=/dev/zero of=src/product.ts",
			"echo x > /dev/nullx",
			"echo x > dev/null",
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(true);
			expect(decision.targets.length).toBeGreaterThan(0);
		}
	});

	it("blocks vim file-switches into .gjc", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("edit", { mode: "vim" }),
			args: {
				file: "packages/coding-agent/src/product.ts",
				steps: [{ kbd: [":edit .gjc/specs/deep-interview-x.md<CR>", "iunsafe"] }],
			},
		});

		expect(decision.blocked).toBe(true);
		expect(decision.message).toContain("runtime-owned");
	});

	it("does not block after deep-interview reaches a terminal phase", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd, "session-a", "complete");

		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(decision.blocked).toBe(false);
	});

	it("allows direct work after the deep-interview suitability gate clears seeded state", async () => {
		const cwd = await makeTempRoot();
		const sessionId = "session-a";
		await writeActiveDeepInterview(cwd, sessionId);

		const beforeClear = await getWorkflowMutationDecision({
			cwd,
			sessionId,
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(beforeClear.blocked).toBe(true);

		const clear = await runNativeStateCommand(
			["clear", "--mode", "deep-interview", "--session-id", sessionId, "--force", "--json"],
			cwd,
		);
		expect(clear.status).toBe(0);
		expect(parseStateCommandJson(clear.stdout)).toMatchObject({
			ok: true,
			skill: "deep-interview",
			active: false,
			current_phase: "complete",
		});

		const afterClear = await getWorkflowMutationDecision({
			cwd,
			sessionId,
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(afterClear.blocked).toBe(false);
	});

	it("allows writes and logs when deep-interview mode state is invalid", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);
		await Bun.write(
			modeStatePath(cwd, "session-a", "deep-interview"),
			JSON.stringify({ active: "yes", current_phase: "interviewing", session_id: "session-a" }),
		);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: "src/product.ts", content: "x" },
			});
			expect(decision.blocked).toBe(false);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("gjc skill-state: invalid mode-state at");
		} finally {
			warn.mockRestore();
		}
	});

	it("allows writes and logs when deep-interview mode state is corrupt JSON", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);
		await Bun.write(modeStatePath(cwd, "session-a", "deep-interview"), "{");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: "src/product.ts", content: "x" },
			});
			expect(decision.blocked).toBe(false);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("invalid JSON");
		} finally {
			warn.mockRestore();
		}
	});

	it("guards deferred ast_edit apply targets unless force override is explicit", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);

		for (const rawPaths of [["src/product.ts"], [".gjc/specs/deep-interview-x.md"], []]) {
			await expect(
				assertWorkflowMutationRawPathsAllowed({
					cwd,
					sessionId: "session-a",
					rawPaths,
				}),
			).rejects.toBeInstanceOf(ToolError);
		}
		await expect(
			assertWorkflowMutationRawPathsAllowed({
				cwd,
				sessionId: "session-a",
				rawPaths: ["src/product.ts"],
				forceOverride: true,
			}),
		).resolves.toBeUndefined();
	});

	it("blocks product mutation during active ralplan and allows neutral temp scratch", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");

		const blocked = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(blocked.blocked).toBe(true);
		expect(blocked.reason).toBe("phase-boundary");
		expect(blocked.message).toBe(RALPLAN_MUTATION_BLOCK_MESSAGE);

		const temp = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "/tmp/ralplan-scratch.md", content: "x" },
		});
		expect(temp.blocked).toBe(false);

		const gjcBash = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("bash"),
			args: { command: "gjc ralplan --write --stage planner --stage_n 1 --artifact /tmp/plan.md" },
		});
		expect(gjcBash.blocked).toBe(false);
	});

	it("blocks product mutation only during the ultragoal goal-planning phase", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ultragoal", "goal-planning");

		const planning = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(planning.blocked).toBe(true);
		expect(planning.reason).toBe("phase-boundary");
		expect(planning.message).toBe(ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE);

		await writeActiveSkill(cwd, "ultragoal", "active");
		const executing = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(executing.blocked).toBe(false);
	});

	it("does not block product mutation while team is active", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "team", "running");

		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(decision.blocked).toBe(false);
	});

	it("keeps blocking ralplan at the pre-approval terminal phases (final, handoff)", async () => {
		const cwd = await makeTempRoot();
		for (const phase of ["final", "handoff"]) {
			await writeActiveSkill(cwd, "ralplan", phase);
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: "src/product.ts", content: "x" },
			});
			expect(decision.blocked).toBe(true);
			expect(decision.message).toBe(RALPLAN_MUTATION_BLOCK_MESSAGE);
		}
	});

	it("keeps blocking deep-interview through its handoff phase but releases on complete", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "deep-interview", "handoff");
		const handoff = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(handoff.blocked).toBe(true);

		await writeActiveSkill(cwd, "deep-interview", "complete");
		const complete = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(complete.blocked).toBe(false);
	});

	it("re-blocks when a planning skill is re-activated after an executor goal completes (skill return)", async () => {
		const cwd = await makeTempRoot();
		// ultragoal finished executing -> not blocked.
		await writeActiveSkill(cwd, "ultragoal", "complete");
		const afterComplete = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(afterComplete.blocked).toBe(false);

		// Returning to ralplan re-activates the planning posture.
		await writeActiveSkill(cwd, "ralplan", "planner");
		const afterReturn = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(afterReturn.blocked).toBe(true);
		expect(afterReturn.message).toBe(RALPLAN_MUTATION_BLOCK_MESSAGE);
	});

	it("follows the current skill after a handoff demotes the prior planning skill", async () => {
		const cwd = await makeTempRoot();
		const sessionId = "session-a";
		const now = new Date().toISOString();
		const sessionDir = sessionStateDir(cwd, sessionId);
		await fs.mkdir(sessionDir, { recursive: true });
		// A real handoff demotes the prior planning skill to active:false and promotes the
		// executor. The demoted deep-interview entry must not keep blocking the executor.
		await Bun.write(
			activeSnapshotPath(cwd, sessionId),
			`${JSON.stringify(
				{
					version: 1,
					active: true,
					skill: "ultragoal",
					phase: "active",
					updated_at: now,
					active_skills: [
						{ skill: "ultragoal", phase: "active", active: true, updated_at: now, session_id: sessionId },
						{
							skill: "deep-interview",
							phase: "handoff",
							active: false,
							updated_at: now,
							session_id: sessionId,
							handoff_to: "ultragoal",
						},
					],
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			modeStatePath(cwd, sessionId, "ultragoal"),
			`${JSON.stringify({ active: true, current_phase: "active", session_id: sessionId }, null, 2)}\n`,
		);
		await Bun.write(
			modeStatePath(cwd, sessionId, "deep-interview"),
			`${JSON.stringify({ active: false, current_phase: "handoff", session_id: sessionId }, null, 2)}\n`,
		);

		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId,
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(decision.blocked).toBe(false);
	});

	it("blocks product-mutating bash during a planning phase but allows sanctioned gjc and artifact writes", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");

		for (const command of [
			"gjc ralplan --write --stage planner --artifact /tmp/p.md ; tee src/product.ts",
			"echo x > src/product.ts",
			"gjc state read && echo x | tee src/product.ts",
			"gjc state read && echo x > .gjc/state/foo.json",
			"gjc ralplan --write --stage planner --artifact /tmp/p.md\ntouch src/product.ts",
			"gjc state read\nrm .gjc/state/foo.json",
			"sed -i s/a/b/ src/product.ts",
			'python -c \'open("src/product.ts", "w").write("x")\'',
			"dd if=/dev/null of=src/product.ts",
			"truncate -s 0 src/product.ts",
			'python <<PY\nopen("src/product.ts", "w").write("x")\nPY',
			// A literal nested shell script is a real command list; its mutations count.
			"bash -c 'rm src/product.ts'",
			"sh -c 'touch src/product.ts'",
			'zsh -c "echo x > src/product.ts"',
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked).toBe(true);
		}

		for (const command of [
			"gjc ralplan --write --stage planner --artifact /tmp/p.md",
			"cat sample.md > .gjc/specs/deep-interview-sample.md",
			// Reading and inspecting must never be blocked during a planning phase,
			// including commands the scanner does not model and read-only wrappers.
			"gjc deep-interview inspect --selector summary --json",
			"cat package.json | jq .name",
			"git status --short",
			"bash -c 'gjc deep-interview inspect --json'",
			'bun -e \'const p=Bun.spawnSync(["gjc","state","read"]); process.stdout.write(p.stdout)\'',
			// Shell metacharacters inside a single-quoted argument value are inert data.
			"gjc deep-interview draft edit --op set --path /a --value 'uses `bun run release`; a > b | c'",
		]) {
			const allowed = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(allowed.blocked).toBe(false);
		}
	});

	it("selects the most-recently-updated workflow skill when several are momentarily active", async () => {
		const cwd = await makeTempRoot();
		const sessionId = "session-a";
		const sessionDir = sessionStateDir(cwd, sessionId);
		await fs.mkdir(sessionDir, { recursive: true });
		const older = new Date(Date.now() - 60_000).toISOString();
		const newer = new Date().toISOString();
		// Stale ralplan `final` (older) coexists with a newer ultragoal executor; the
		// newer executor must win so product mutation is allowed.
		await Bun.write(
			activeSnapshotPath(cwd, sessionId),
			`${JSON.stringify(
				{
					version: 1,
					active: true,
					skill: "ralplan",
					phase: "final",
					updated_at: older,
					active_skills: [
						{ skill: "ralplan", phase: "final", active: true, updated_at: older, session_id: sessionId },
						{ skill: "ultragoal", phase: "active", active: true, updated_at: newer, session_id: sessionId },
					],
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			modeStatePath(cwd, sessionId, "ralplan"),
			`${JSON.stringify({ active: true, current_phase: "final", session_id: sessionId }, null, 2)}\n`,
		);
		await Bun.write(
			modeStatePath(cwd, sessionId, "ultragoal"),
			`${JSON.stringify({ active: true, current_phase: "active", session_id: sessionId }, null, 2)}\n`,
		);

		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId,
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(decision.blocked).toBe(false);
	});

	it("blocks a temp symlink whose real target is inside the project tree", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-guard-symlink-"));
		tempRoots.push(linkDir);
		const link = path.join(linkDir, "into-repo");
		await fs.symlink(path.join(cwd, "src"), link);

		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: path.join(link, "product.ts"), content: "x" },
		});
		expect(decision.blocked).toBe(true);
	});

	it("blocks .gjc raw paths in deferred ast_edit apply even with no planning skill or forceOverride", async () => {
		const cwd = await makeTempRoot();
		await expect(
			assertWorkflowMutationRawPathsAllowed({ cwd, rawPaths: [".gjc/specs/x.md"] }),
		).rejects.toBeInstanceOf(ToolError);
		await expect(
			assertWorkflowMutationRawPathsAllowed({
				cwd,
				rawPaths: [".gjc/state/ralplan-state.json"],
				forceOverride: true,
			}),
		).rejects.toBeInstanceOf(ToolError);
	});

	it("BashTool-shaped product mutation throws ToolError and leaves files byte-identical (#2698 / #2665)", async () => {
		// Mirrors the agent-session bash wrapper: assertWorkflowMutationAllowed runs
		// before BashTool.execute. A blocked mutation must not touch product or
		// workflow state bytes — decision-only tests alone do not prove that.
		const { assertWorkflowMutationAllowed } = await import(
			"@gajae-code/coding-agent/skill-state/workflow-mutation-guard"
		);
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		const productPath = path.join(cwd, "src", "product.ts");
		const productBefore = 'export const sentinel = "UNTOUCHED-PRODUCT-BYTES";\n';
		await Bun.write(productPath, productBefore);
		const modePath = modeStatePath(cwd, "session-a", "deep-interview");
		const modeBefore = await fs.readFile(modePath);

		await expect(
			assertWorkflowMutationAllowed({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command: "printf x > src/product.ts" },
			}),
		).rejects.toBeInstanceOf(ToolError);

		const productAfter = await fs.readFile(productPath, "utf8");
		const modeAfter = await fs.readFile(modePath);
		expect(productAfter).toBe(productBefore);
		expect(Buffer.compare(modeBefore, modeAfter)).toBe(0);
	});
});
