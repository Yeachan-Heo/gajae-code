import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import * as autoresearchGit from "@gajae-code/coding-agent/autoresearch/git";
import {
	activeSnapshotPath,
	modeStatePath,
	sessionStateDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import {
	assertWorkflowMutationAllowed,
	assertWorkflowMutationRawPathsAllowed,
	DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE,
	getWorkflowMutationDecision,
	isWorkflowMutationTool,
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

/** A directory that is not the project cwd and not a platform temp root. */
async function makeNonNeutralDir(): Promise<string> {
	// Bun's os.userInfo().homedir follows HOME, which shard harnesses may place
	// below /tmp. Use a sibling of the checkout so this target is not neutral temp.
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	return fs.mkdtemp(path.join(path.dirname(repoRoot), "gjc-plan-tmpdir-"));
}

async function removeDirLeafFirst(dir: string): Promise<void> {
	let names: string[] = [];
	try {
		names = await fs.readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const child = path.join(dir, name);
		if ((await fs.lstat(child)).isDirectory()) await removeDirLeafFirst(child);
		else await fs.rm(child, { force: true });
	}
	await fs.rmdir(dir);
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
	skill: "deep-interview" | "ralplan" | "ultragoal" | "autoresearch",
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

function makeSeededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function seededToken(random: () => number, length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let value = "";
	for (let index = 0; index < length; index++) {
		value += alphabet[Math.floor(random() * alphabet.length)] ?? "a";
	}
	return value;
}

function quoteBashSingle(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteBashDouble(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function quoteBashAnsiC(value: string): string {
	return `$'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`;
}

function quoteBashConcatenation(value: string, firstSplit: number, secondSplit: number): string {
	return [
		quoteBashSingle(value.slice(0, firstSplit)),
		quoteBashDouble(value.slice(firstSplit, secondSplit)),
		quoteBashAnsiC(value.slice(secondSplit)),
	].join("");
}

const projectTmpdirProbe = path.join(import.meta.dir, "fixtures/workflow-mutation-tmpdir-probe.ts");

async function runProjectTmpdirProbe(input: {
	cwd: string;
	processCwd?: string;
	target: string;
	sessionId: string;
	drop?: "unlink" | "chdir";
	tmpdir?: string;
	expectedTmpdir?: string;
}): Promise<{ blocked: boolean; message?: string }> {
	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	if (input.expectedTmpdir !== undefined) delete env.TMPDIR;
	if (input.tmpdir !== undefined) env.TMPDIR = input.tmpdir;
	env.GJC_TMPDIR_PROBE_CWD = input.cwd;
	env.GJC_TMPDIR_PROBE_PATH = input.target;
	env.GJC_TMPDIR_PROBE_SESSION = input.sessionId;
	if (input.drop) env.GJC_TMPDIR_PROBE_DROP = input.drop;
	if (input.expectedTmpdir !== undefined) env.GJC_TMPDIR_PROBE_EXPECT = input.expectedTmpdir;
	const proc = Bun.spawn([process.execPath, projectTmpdirProbe], {
		cwd: input.processCwd ?? input.cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`tmpdir probe failed (${exitCode}): ${stderr || stdout}`);
	let parsed: { blocked?: unknown; message?: unknown };
	try {
		parsed = JSON.parse(stdout.trim()) as { blocked?: unknown; message?: unknown };
	} catch {
		throw new Error(`tmpdir probe did not print JSON: ${stdout}`);
	}
	if (typeof parsed.blocked !== "boolean") throw new Error(`tmpdir probe JSON missing blocked: ${stdout}`);
	if (parsed.message !== undefined && typeof parsed.message !== "string") {
		throw new Error(`tmpdir probe JSON message was not a string: ${stdout}`);
	}
	return { blocked: parsed.blocked, message: parsed.message };
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
			...(["deep-interview", "ralplan", "ultragoal", "autoresearch"] as const).map(
				skill =>
					[
						`write ${skill}`,
						tool("write"),
						{ path: `.gjc/state/sessions/session-a/${skill}-state.json`, content: "{}" },
					] as [string, AgentTool, unknown],
			),
			...(["deep-interview", "ralplan", "ultragoal", "autoresearch"] as const).map(
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
					input: "*** Begin Patch\n*** Update File: .gjc/state/autoresearch-state.json\n@@\n-a\n+b\n*** End Patch\n",
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
				{ paths: [".gjc/state/**/autoresearch-state.json"], ops: [{ pat: "foo", out: "bar" }] },
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
			expect(decision.blocked, command).toBe(false);
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

	it("blocks bash writes to another session's specs and plans during planning", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd, "session-a");

		for (const command of [
			"echo x > .gjc/_session-session-b/specs/deep-interview-x.md",
			"echo x > .gjc/_session-session-b/plans/plan.md",
			"mkdir -p .gjc/_session-session-a-extra/specs",
			"echo x > .gjc/_session-session-a/specs/a.md; echo y > .gjc/_session-session-b/plans/b.md",
		]) {
			await expect(
				assertWorkflowMutationAllowed({
					cwd,
					sessionId: "session-a",
					tool: tool("bash"),
					args: { command },
				}),
			).rejects.toThrow(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
		}

		await writeActiveDeepInterview(cwd, "a.b");
		await expect(
			assertWorkflowMutationAllowed({
				cwd,
				sessionId: "a.b",
				tool: tool("bash"),
				args: { command: "echo x > .gjc/_session-a.b/specs/x.md" },
			}),
		).rejects.toThrow(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
	});

	it("allows the current session's specs and plans and unscoped planning artifacts", async () => {
		const cwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd, "session-a");

		for (const command of [
			"echo x > .gjc/_session-session-a/specs/deep-interview-x.md",
			"echo x > .gjc/_session-session-a/plans/plan.md",
			"cat source.md > .gjc/specs/deep-interview-x.md",
			"mkdir -p .gjc/plans",
		]) {
			await assertWorkflowMutationAllowed({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
		}

		const directWrite = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: ".gjc/_session-session-a/specs/deep-interview-x.md", content: "x" },
		});
		expect(directWrite.blocked).toBe(true);
		expect(directWrite.reason).toBe("gjc-target");

		await writeActiveDeepInterview(cwd, "a.b");
		await assertWorkflowMutationAllowed({
			cwd,
			sessionId: "a.b",
			tool: tool("bash"),
			args: { command: "echo x > .gjc/_session-a%2Eb/specs/x.md" },
		});
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

	it("keeps an unsigned stricter phase when the active entry has left planning", async () => {
		const cwd = await makeTempRoot();
		const sessionId = "session-a";
		await writeActiveSkill(cwd, "ultragoal", "active", sessionId);
		await fs.writeFile(
			modeStatePath(cwd, sessionId, "ultragoal"),
			`${JSON.stringify({ active: true, current_phase: "goal-planning", session_id: sessionId }, null, 2)}\n`,
		);
		const edit = {
			cwd,
			sessionId,
			tool: tool("edit"),
			args: { path: "src/product.ts", edits: [{ old_text: "a", new_text: "b" }] },
		};
		await expect(assertWorkflowMutationAllowed(edit)).rejects.toBeInstanceOf(ToolError);
		const decision = await getWorkflowMutationDecision(edit);
		expect(decision.blocked).toBe(true);
		expect(decision.reason).toBe("phase-boundary");
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

	it("blocks product mutation during an autoresearch mission that is not branch-isolated", async () => {
		// Research-only is now enforced, not merely documented: off an
		// `autoresearch/*` branch a mission would be editing the user's working
		// branch, which the contract forbids.
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "src/product.ts", content: "x" },
		});
		expect(decision.blocked).toBe(true);
		expect(decision.message).toContain("research-only");
	});

	it("keeps product mutation blocked on an autoresearch/* branch — branch name is not authorization", async () => {
		// Research-only is enforced by PATH, never by branch name: an isolation
		// branch contains keep/discard bookkeeping, it does not turn product
		// edits into research.
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");
		const branchSpy = vi
			.spyOn(autoresearchGit, "getCurrentAutoresearchBranch")
			.mockResolvedValue("autoresearch/decode-throughput-20260814");
		try {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: "src/product.ts", content: "x" },
			});
			expect(decision.blocked).toBe(true);
			expect(decision.message).toContain("research-only");

			// The mission's own research artifact stays writable on that branch.
			const harness = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: "autoresearch.sh", content: "#!/usr/bin/env bash\n" },
			});
			expect(harness.blocked).toBe(false);
		} finally {
			branchSpy.mockRestore();
		}
	});

	it("keeps the mission research artifact writable during an autoresearch mission", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "autoresearch.sh", content: "#!/usr/bin/env bash\n" },
		});
		expect(decision.blocked).toBe(false);
	});

	it("releases autoresearch mutation at its terminal phases", async () => {
		const cwd = await makeTempRoot();
		for (const phase of ["complete", "cancelled"]) {
			await writeActiveSkill(cwd, "autoresearch", phase);
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("write"),
				args: { path: "src/product.ts", content: "x" },
			});
			expect(decision.blocked).toBe(false);
		}
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

	it("blocks a project dotenv TMPDIR as a planning temp root", async () => {
		// The parent already imported the guard. The child imports it after `.env` exists.
		for (const drop of ["unlink", "chdir"] as const) {
			const workspace = await makeTempRoot();
			await writeActiveDeepInterview(workspace);
			const projectTmp = await makeNonNeutralDir();
			try {
				const product = path.join(projectTmp, "src", "product.ts");
				await fs.mkdir(path.dirname(product), { recursive: true });
				await Bun.write(product, "original\n");
				await Bun.write(path.join(workspace, ".env"), `TMPDIR=${projectTmp}\n`);

				const decision = await runProjectTmpdirProbe({
					cwd: workspace,
					target: product,
					sessionId: "session-a",
					drop,
					expectedTmpdir: projectTmp,
				});
				expect(decision.blocked, drop).toBe(true);
				expect(decision.message, drop).toBe(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
				expect(await Bun.file(product).text(), drop).toBe("original\n");
			} finally {
				await removeDirLeafFirst(projectTmp);
			}
		}
	}, 60_000);

	it("uses the caller cwd dotenv snapshot when the guard was imported elsewhere", async () => {
		const cwd = await makeTempRoot();
		const processCwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);
		const projectTmp = await makeNonNeutralDir();
		try {
			const product = path.join(projectTmp, "src", "product.ts");
			await fs.mkdir(path.dirname(product), { recursive: true });
			await Bun.write(product, "original\n");
			await Bun.write(path.join(cwd, ".env"), `TMPDIR=${projectTmp}\n`);

			const decision = await runProjectTmpdirProbe({
				cwd,
				processCwd,
				target: product,
				sessionId: "session-a",
				tmpdir: projectTmp,
				expectedTmpdir: projectTmp,
			});
			expect(decision.blocked).toBe(true);
			expect(decision.message).toBe(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
			expect(await Bun.file(product).text()).toBe("original\n");
		} finally {
			await removeDirLeafFirst(projectTmp);
		}
	}, 60_000);

	it("fails closed when the caller cwd dotenv exceeds the bounded snapshot size", async () => {
		const cwd = await makeTempRoot();
		const processCwd = await makeTempRoot();
		await writeActiveDeepInterview(cwd);
		const projectTmp = await makeNonNeutralDir();
		try {
			const product = path.join(projectTmp, "src", "product.ts");
			await fs.mkdir(path.dirname(product), { recursive: true });
			await Bun.write(product, "original\n");
			await Bun.write(path.join(cwd, ".env"), `TMPDIR=${projectTmp}\n${"#".repeat(128 * 1024)}\n`);

			const decision = await runProjectTmpdirProbe({
				cwd,
				processCwd,
				target: product,
				sessionId: "session-a",
				tmpdir: projectTmp,
			});
			expect(decision.blocked).toBe(true);
			expect(decision.message).toBe(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
			expect(await Bun.file(product).text()).toBe("original\n");
		} finally {
			await removeDirLeafFirst(projectTmp);
		}
	}, 60_000);

	it("still allows the real OS temp dir during an active planning phase", async () => {
		const workspace = await makeTempRoot();
		await writeActiveDeepInterview(workspace);
		const realOsTemp = process.env.TMPDIR?.trim() || os.tmpdir();
		const scratch = path.join(realOsTemp, `gjc-plan-os-scratch-${process.pid}.md`);
		const allowed = await runProjectTmpdirProbe({
			cwd: workspace,
			target: scratch,
			sessionId: "session-a",
		});
		expect(allowed.blocked).toBe(false);
	}, 60_000);

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

	it("keeps the planning block when mode-state is forged out of band", async () => {
		for (const [skill, phase] of [
			["ralplan", "planner"],
			["deep-interview", "interviewing"],
		] as const) {
			const cwd = await makeTempRoot();
			const sessionId = "session-a";
			const written = await runNativeStateCommand(
				[
					"write",
					"--mode",
					skill,
					"--input",
					JSON.stringify({ current_phase: phase }),
					"--session-id",
					sessionId,
					"--json",
				],
				cwd,
			);
			expect(written.status, skill).toBe(0);

			const edit = {
				cwd,
				sessionId,
				tool: tool("edit"),
				args: { path: "src/product.ts", edits: [{ old_text: "a", new_text: "b" }] },
			};
			await expect(assertWorkflowMutationAllowed(edit)).rejects.toBeInstanceOf(ToolError);

			const statePath = modeStatePath(cwd, sessionId, skill);
			const stamped = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, unknown>;
			await fs.writeFile(statePath, `${JSON.stringify({ ...stamped, current_phase: "complete" }, null, 2)}\n`);
			await expect(assertWorkflowMutationAllowed(edit)).rejects.toBeInstanceOf(ToolError);
			const forgedPhase = await getWorkflowMutationDecision(edit);
			expect(forgedPhase.blocked, skill).toBe(true);
			expect(forgedPhase.reason, skill).toBe("phase-boundary");

			await fs.writeFile(
				statePath,
				`${JSON.stringify({ ...stamped, active: false, current_phase: "complete" }, null, 2)}\n`,
			);
			await expect(assertWorkflowMutationAllowed(edit)).rejects.toBeInstanceOf(ToolError);

			await fs.writeFile(
				statePath,
				`${JSON.stringify({ active: true, current_phase: "complete", session_id: sessionId }, null, 2)}\n`,
			);
			await expect(assertWorkflowMutationAllowed(edit)).rejects.toBeInstanceOf(ToolError);

			await fs.writeFile(
				statePath,
				`${JSON.stringify({ active: true, current_phase: phase, session_id: "session-b" }, null, 2)}\n`,
			);
			await expect(assertWorkflowMutationAllowed(edit)).rejects.toBeInstanceOf(ToolError);
			await fs.writeFile(
				statePath,
				`${JSON.stringify({ active: true, current_phase: "complete", session_id: "session-b" }, null, 2)}\n`,
			);
			await expect(assertWorkflowMutationAllowed(edit)).rejects.toBeInstanceOf(ToolError);

			const restored = await runNativeStateCommand(
				[
					"write",
					"--mode",
					skill,
					"--input",
					JSON.stringify({ current_phase: phase }),
					"--session-id",
					sessionId,
					"--force",
					"--json",
				],
				cwd,
			);
			expect(restored.status, skill).toBe(0);
			await expect(assertWorkflowMutationAllowed(edit)).rejects.toBeInstanceOf(ToolError);

			const cleared = await runNativeStateCommand(
				["clear", "--mode", skill, "--session-id", sessionId, "--force", "--json"],
				cwd,
			);
			expect(cleared.status, skill).toBe(0);
			await assertWorkflowMutationAllowed(edit);
			expect((await getWorkflowMutationDecision(edit)).blocked, skill).toBe(false);
		}
	});
});

describe("bash scanner command substitutions", () => {
	function decideBash(cwd: string, command: string) {
		return getWorkflowMutationDecision({ cwd, sessionId: "session-a", tool: tool("bash"), args: { command } });
	}

	it("scans command substitutions as the live code they are", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		// A substitution executes even inside a double-quoted span, so its body is
		// a nested command list and must be scanned like an `sh -c` payload.
		for (const command of [
			'echo "$(rm -rf src/product.ts)"',
			'echo "`rm -rf src/product.ts`"',
			"echo $(printf x > src/product.ts)",
			'echo "$(echo "$(rm -rf src/product.ts)")"',
		]) {
			expect((await decideBash(cwd, command)).blocked, command).toBe(true);
		}

		// Single quotes suppress substitution entirely, so this one is inert text.
		expect((await decideBash(cwd, `gjc autoresearch verdict --evidence '$(echo inert)' --evaluator r`)).blocked).toBe(
			false,
		);
	});

	it("tracks quotes the way the shell does while locating substitutions", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		for (const command of [
			// An apostrophe inside a double-quoted word is data, not a single-quote
			// opener; the substitution after it is still live.
			`echo "it's $(rm -rf src/product.ts)"`,
			// A `)` inside a quoted argument does not close the body; the trailing
			// command is still part of the substitution.
			`echo "$(printf ')'; rm -rf src/product.ts)"`,
			`echo "$(printf ")"; rm -rf src/product.ts)"`,
			// Backtick body with an escaped backtick inside.
			'echo "`printf \\`; rm -rf src/product.ts`"',
		]) {
			expect((await decideBash(cwd, command)).blocked, command).toBe(true);
		}
	});

	it("fails closed on an unbalanced substitution", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "deep-interview", "interviewing");
		for (const command of ['echo "$(rm -rf src/product.ts"', 'echo "`rm -rf src/product.ts"']) {
			const decision = await decideBash(cwd, command);
			expect(decision.blocked, command).toBe(true);
			expect(decision.reason).toBe("unknown-target");
		}
	});

	it("fails closed when substitution parser frames exceed their nesting bound", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "deep-interview", "interviewing");
		const nested = `${"$(".repeat(128)}rm -rf src/product.ts${")".repeat(128)}`;
		const decision = await decideBash(cwd, `printf "%s" "${nested}"`);
		expect(decision.blocked).toBe(true);
		expect(decision.reason).toBe("unknown-target");
	});

	it("ignores substitutions in literal data heredocs and shell comments", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "deep-interview", "interviewing");

		for (const command of [
			"cat <<'EOF' > /tmp/spec.md\n$(rm -rf src/product.ts)\nEOF",
			"cat <<'EOF' > /tmp/spec.md\n`rm -rf src/product.ts`\nEOF",
			"# $(rm -rf src/product.ts) and an 'unterminated quote\ncat <<'EOF' > /tmp/spec.md\nsafe\nEOF",
			"printf '%s' safe # `rm -rf src/product.ts` and an 'unterminated quote\ncat <<'EOF' > /tmp/spec.md\nsafe\nEOF",
			"printf '%s' safe # $(rm -rf src/product.ts)\ncat <<'EOF' > /tmp/spec.md\nsafe\nEOF",
		]) {
			const decision = await decideBash(cwd, command);
			expect(decision.blocked, command).toBe(false);
		}
	});

	it("keeps live substitutions and executable or expanding heredocs blocked", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "deep-interview", "interviewing");

		for (const command of [
			'printf "%s" "$(rm -rf src/product.ts)"',
			'printf "%s" "$(printf "#"; rm -rf src/product.ts)"',
			'printf "%s" "$(printf ")"; rm -rf src/product.ts)"',
			'printf "%s" "# $(rm -rf src/product.ts)"',
			"printf '%s' foo\\# $(rm -rf src/product.ts)",
			"printf '%s' foo# $(rm -rf src/product.ts)",
			"bash <<'EOF'\nrm src/product.ts\nEOF",
			"cat <<'EOF' | bash\nrm src/product.ts\nEOF",
			"cat <<EOF > /tmp/spec.md\n$(rm src/product.ts)\nEOF",
		]) {
			const decision = await decideBash(cwd, command);
			expect(decision.blocked, command).toBe(true);
		}
	});
});

describe("autoresearch research-only allowance", () => {
	function decideBash(cwd: string, command: string) {
		return getWorkflowMutationDecision({ cwd, sessionId: "session-a", tool: tool("bash"), args: { command } });
	}

	it("fails closed on an opaque interpreter write that names no target", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		// These resolve to NO extracted target, so an allowance keyed on
		// `paths.every(...)` alone is vacuously true and waves them through even
		// though they really do overwrite product code.
		for (const command of [
			`python3 -c "open('src/product.ts','w').write('x')"`,
			`node -e "require('fs').writeFileSync('src/product.ts','x')"`,
		]) {
			expect((await decideBash(cwd, command)).blocked, command).toBe(true);
		}
	});

	it("blocks shell mutations of the harness while allowing execution and the mission CLI", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		for (const command of [
			"echo '#!/bin/sh' > autoresearch.sh",
			"chmod +x autoresearch.sh",
			"ln -sf src/product.ts autoresearch.sh",
		]) {
			expect((await decideBash(cwd, command)).blocked, command).toBe(true);
		}

		for (const command of ["bash autoresearch.sh", "gjc autoresearch read --json"]) {
			expect((await decideBash(cwd, command)).blocked, command).toBe(false);
		}
	});
});

describe("bash scanner quoting model", () => {
	function decideBash(cwd: string, command: string) {
		return getWorkflowMutationDecision({ cwd, sessionId: "session-a", tool: tool("bash"), args: { command } });
	}

	it("treats shell metacharacters inside double-quoted prose as literal data", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		// Every one of these is a sanctioned CLI call whose quoted VALUE merely
		// mentions `>`/`->` or a destructive word. None of them writes a file.
		for (const command of [
			`gjc autoresearch verdict --status-json '{"v":1}' --evidence "p99 500ms -> 120ms" --evaluator run-3 --json`,
			'gjc autoresearch verdict --evidence "throughput > baseline" --evaluator run-3 --json',
			'gjc autoresearch critic --caveat "n=3 -> low power" --evaluator critic-1 --json',
			'gjc autoresearch verdict --evidence "we did not rm the cache; mv was avoided" --evaluator r',
			'git commit -m "fix thing\\nrm was considered\\n"',
		]) {
			const decision = await decideBash(cwd, command);
			expect(decision.blocked).toBe(false);
			expect(decision.targets).toEqual([]);
		}
	});

	it("still blocks real writes around and after quoted prose", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		for (const command of [
			'echo "harmless -> prose" > src/product.ts',
			'echo "a > b" > src/product.ts && echo "c -> d"',
			'echo "metric -> value" | tee src/product.ts',
			'echo "he said \\"hi\\"" > src/product.ts',
			"echo pwned > src/product.ts",
			"rm -rf src/product.ts",
		]) {
			expect((await decideBash(cwd, command)).blocked).toBe(true);
		}
	});

	it("blocks mutators reached through a root-level compound command", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		// The mutation regex keys on a `;`/`|`/`&`/newline before the command word.
		// A root compound puts the mutator after a KEYWORD instead, so these used to
		// extract no target and no unknown flag, and the planning guard allowed them.
		for (const command of [
			"{ rm src/product.ts; }",
			"if true; then rm src/product.ts; fi",
			"for f in a; do rm src/product.ts; done",
			"while true; do printf x > src/product.ts; done",
			"case x in a) rm src/product.ts;; esac",
		]) {
			expect((await decideBash(cwd, command)).blocked, command).toBe(true);
		}
	});

	it("blocks mutators reached through an executable wrapper", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		for (const command of [
			"command rm src/product.ts",
			"builtin rm src/product.ts",
			"env rm src/product.ts",
			"env FOO=bar rm src/product.ts",
			"exec rm src/product.ts",
			"nohup rm src/product.ts",
			"nice -n 5 rm src/product.ts",
			"command tee src/product.ts",
		]) {
			expect((await decideBash(cwd, command)).blocked, command).toBe(true);
		}
	});

	it("normalizes ANSI-C and locale-quoted executable names", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		// Bash drops the `$` during quote removal, so these really execute `rm`.
		for (const command of ["$'rm' src/product.ts", '$"rm" src/product.ts', "$'r''m' src/product.ts"]) {
			expect((await decideBash(cwd, command)).blocked, command).toBe(true);
		}
	});

	it("classifies single-quoted redirection operands like double-quoted ones", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		// `/dev/null` is a sanctioned sink in either quoting style.
		for (const command of ["printf x > '/dev/null'", "printf x >> '/dev/null'", "dd if=a of='/dev/null'"]) {
			expect((await decideBash(cwd, command)).blocked, command).toBe(false);
		}
		// A single-quoted product path is still a real write.
		for (const command of [
			"printf x > 'src/product.ts'",
			"printf x >> 'src/product.ts'",
			"dd if=a of='src/product.ts'",
		]) {
			expect((await decideBash(cwd, command)).blocked, command).toBe(true);
		}
	});

	it("stays fail-closed on an unbalanced quote", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");
		for (const command of ['echo "unterminated > src/product.ts', "echo 'unterminated > src/product.ts"]) {
			expect((await decideBash(cwd, command)).blocked).toBe(true);
		}
	});

	it("blocks quote-boundary bypass attempts", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		for (const command of [
			'gjc autoresearch verdict --evidence "safe" > src/product.ts',
			'gjc autoresearch verdict --evidence "a > b"; rm src/product.ts',
			'gjc autoresearch verdict --evidence "p99 -> ok" && rm -rf src/product.ts',
			`sh -c "echo 'a -> b' > src/product.ts"`,
			'dd if=/dev/zero of="src/product.ts" count=1',
			'printf x > "src/product.ts"',
			'printf x >> "src/product.ts"',
		]) {
			expect((await decideBash(cwd, command)).blocked).toBe(true);
		}
	});

	it("blocks quoted and quote-split mutators in planning and autoresearch phases", async () => {
		const commands = [
			'rm "src/product.ts"',
			'r"m" -rf src/product.ts',
			"r'm' -rf 'src/product.ts'",
			'r\\\nm "src/product.ts"',
			"echo \"$(printf 'x)'; rm src/product.ts)\"",
			'echo "$(printf "x)"; rm src/product.ts)"',
			'echo "$(printf "$(printf \'x)\')"; rm src/product.ts)"',
			'echo "$(printf x\\); rm src/product.ts)"',
			'echo "$(printf \\ #; rm src/product.ts)"',
			'echo "$(printf x # )\nrm src/product.ts)"',
			'echo "$(case x in x) true;; esac; rm src/product.ts)"',
		];

		for (const [skill, phase] of [
			["deep-interview", "interviewing"],
			["ralplan", "planner"],
			["autoresearch", "research"],
		] as const) {
			const cwd = await makeTempRoot();
			await writeActiveSkill(cwd, skill, phase);
			for (const command of commands) {
				const decision = await decideBash(cwd, command);
				expect(decision.blocked, command).toBe(true);
				expect(decision.targets, command).toContain("src/product.ts");
			}
		}
	});

	it("fails closed on a recognized targetless mutator during autoresearch", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		const decision = await decideBash(cwd, "rm -rf");
		expect(decision.blocked).toBe(true);
		expect(decision.reason).toBe("unknown-target");
		expect(decision.targets).toEqual([]);
	});

	it("fails closed on unmodeled compound commands in live substitutions", async () => {
		for (const [skill, phase] of [
			["deep-interview", "interviewing"],
			["ralplan", "planner"],
			["autoresearch", "research"],
		] as const) {
			const cwd = await makeTempRoot();
			await writeActiveSkill(cwd, skill, phase);
			for (const command of [
				'echo "$({ rm -f src/product.ts; })"',
				'echo "$(if true; then rm src/product.ts; fi)"',
				'echo "$(for x in one; do rm src/product.ts; done)"',
				'echo "$(while false; do rm src/product.ts; done)"',
				'echo "$(until true; do rm src/product.ts; done)"',
				'echo "$(! rm src/product.ts)"',
				'echo "$(time rm src/product.ts)"',
				'echo "`{ rm -f src/product.ts; }`"',
				'touch autoresearch.sh; echo "$({ rm -f src/product.ts; })"',
			]) {
				const decision = await decideBash(cwd, command);
				expect(decision.blocked, command).toBe(true);
				expect(decision.reason, command).toBe("unknown-target");
			}
		}
	});

	it("allows quoted non-mutator arguments while retaining quoted redirection targets", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");

		for (const command of [
			'git commit -m "rm src/product.ts"',
			'echo "a > b; rm src/product.ts"',
			'printf x > "/dev/null"',
			"echo \"$(printf 'x)')\"",
			'echo "$(printf x # ) rm src/product.ts\n)"',
		]) {
			const decision = await decideBash(cwd, command);
			expect(decision.blocked).toBe(false);
		}

		const redirected = await decideBash(cwd, 'printf x > "src/product.ts"');
		expect(redirected.blocked).toBe(true);
		expect(redirected.targets).toContain("src/product.ts");
	});

	it("treats an escaped quote as keeping the span open, matching the shell", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");
		// A real shell prints `x " > src/product.ts` and creates no file: the
		// escaped quote does not close the span, so the `>` never redirects.
		expect((await decideBash(cwd, 'echo "x \\" > src/product.ts"')).blocked).toBe(false);
	});

	it("covers eval and python on the same mutation-tool gate as edit and bash", () => {
		expect(isWorkflowMutationTool("eval")).toBe(true);
		expect(isWorkflowMutationTool("python")).toBe(true);
		expect(isWorkflowMutationTool("read")).toBe(false);
	});

	it("blocks eval and python product writes during ralplan through the public guard", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const cases: Array<[string, unknown]> = [
			["python", { code: 'write("src/product.ts", "x")\n' }],
			["python", { code: 'open("src/product.ts", "w").write("x")\n' }],
			["python", { code: 'from pathlib import Path\nPath("src/product.ts").write_text("x")\n' }],
			["python", { code: 'os.remove("src/product.ts")\n' }],
			["python", { code: 'shutil.copy("/tmp/ralplan-scratch.md", "src/product.ts")\n' }],
			["python", { code: 'os.rename("/tmp/ralplan-scratch.md", "src/product.ts")\n' }],
			[
				"eval",
				{ cells: [{ language: "js", code: 'fs.renameSync("/tmp/ralplan-scratch.md", "src/product.ts")\n' }] },
			],
			[
				"eval",
				{ cells: [{ language: "js", code: 'fs.copyFileSync("/tmp/ralplan-scratch.md", "src/product.ts")\n' }] },
			],
			["eval", { cells: [{ language: "py", code: 'append("src/product.ts", "x")\n' }] }],
			["eval", { cells: [{ language: "js", code: 'await write("src/product.ts", "x")\n' }] }],
			["eval", { cells: [{ language: "js", code: 'await Bun.write("src/product.ts", "x")\n' }] }],
			["python", { code: 'write("/tmp/ralplan-scratch.md", "x")\nwrite("src/product.ts", "y")\n' }],
		];
		for (const [name, args] of cases) {
			const input = { cwd, sessionId: "session-a", tool: tool(name), args };
			await expect(assertWorkflowMutationAllowed(input)).rejects.toBeInstanceOf(ToolError);
			const decision = await getWorkflowMutationDecision(input);
			expect(decision.blocked, name).toBe(true);
			expect(decision.reason, `${name} ${JSON.stringify(args)}`).toBe("phase-boundary");
			expect(decision.message).toBe(RALPLAN_MUTATION_BLOCK_MESSAGE);
		}
		for (const [name, args] of [
			["python", { code: 'exec("open(\\"src/product.ts\\",\\"w\\").write(\\"x\\")")\n' }],
			["python", { code: `value = f"{exec('open("src/product.ts","w").write("x")')}"\n` }],
			["eval", { cells: [{ language: "py", code: '__import__("os").system("echo x > src/product.ts")\n' }] }],
		] as const) {
			const input = { cwd, sessionId: "session-a", tool: tool(name), args };
			await expect(assertWorkflowMutationAllowed(input)).rejects.toBeInstanceOf(ToolError);
			const decision = await getWorkflowMutationDecision(input);
			expect(decision.blocked, name).toBe(true);
			expect(decision.reason, `${name} ${JSON.stringify(args)}`).toBe("unknown-target");
		}
	});

	it("blocks eval and python product writes during an autoresearch mission", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");
		for (const [name, args] of [
			["python", { action: "execute", code: 'write("src/product.ts", "x")\n' }],
			["eval", { cells: [{ language: "js", code: 'fs.writeFileSync("src/product.ts", "x")\n' }] }],
			["python", { code: 'shutil.copy("/tmp/ralplan-scratch.md", "src/product.ts")\n' }],
		] as const) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool(name),
				args,
			});
			expect(decision.blocked).toBe(true);
			expect(decision.message).toContain("research-only");
		}
	});

	it("requires direct file tools for harness writes and allows non-mutating eval or python", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "autoresearch", "research");
		for (const [name, args] of [
			["python", { code: 'write("autoresearch.sh", "#!/usr/bin/env bash\\n")\n' }],
			[
				"eval",
				{ cells: [{ language: "js", code: 'fs.writeFileSync("autoresearch.sh", "#!/usr/bin/env bash\\n")\n' }] },
			],
		] as const) {
			const codeWrite = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool(name),
				args,
			});
			expect(codeWrite.blocked).toBe(true);
		}
		const direct = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("write"),
			args: { path: "autoresearch.sh", content: "#!/usr/bin/env bash\n" },
		});
		expect(direct.blocked).toBe(false);
		const edited = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("edit"),
			args: { path: "autoresearch.sh", edits: [{ old_text: "METRIC old", new_text: "METRIC new" }] },
		});
		expect(edited.blocked).toBe(false);

		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const [name, args] of [
			["python", { code: "print(1 + 1)\n" }],
			["python", { code: 'text = read("package.json")\n' }],
			["python", { code: 'open("src/product.ts", encoding="utf-8").read()\n' }],
			["python", { code: '# write("src/product.ts", "x")\nprint(1)\n' }],
			["python", { code: "print(\"write('src/product.ts', 'x')\")\n" }],
			["python", { action: "clear" }],
			["python", { code: 'write("/tmp/ralplan-scratch.md", "x")\n' }],
			["python", { code: 'shutil.copy("/tmp/ralplan-scratch.md", "/tmp/ralplan-other.md")\n' }],
			["eval", { cells: [{ language: "py", code: "print(1 + 1)\n" }] }],
			["eval", { cells: [{ language: "js", code: 'await read("package.json")\n' }] }],
			["eval", { cells: [{ language: "js", code: 'file.write("not-a-product-write")\n' }] }],
		] as const) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool(name),
				args,
			});
			expect(decision.blocked, `${name} ${JSON.stringify(args)}`).toBe(false);
		}
	});

	it("still allows eval and python product writes when no planning skill is active", async () => {
		const cwd = await makeTempRoot();
		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("python"),
			args: { code: 'write("src/product.ts", "x")\n' },
		});
		expect(decision.blocked).toBe(false);
	});

	it("fails closed when an eval or python write target is not a literal", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const [name, args] of [
			["python", { code: 'write(path, "x")\n' }],
			["eval", { cells: [{ language: "js", code: "await write(target, 'x')\n" }] }],
		] as const) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool(name),
				args,
			});
			expect(decision.blocked).toBe(true);
			expect(decision.reason).toBe("unknown-target");
		}
	});

	it("fails closed when a literal path prefix is followed by an expression", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("python"),
			args: { code: 'write("/tmp/" + target, "x")\n' },
		});
		expect(decision.blocked).toBe(true);
		expect(decision.reason).toBe("unknown-target");
	});

	it("finds Python open write mode after other keyword arguments", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const input = {
			cwd,
			sessionId: "session-a",
			tool: tool("python"),
			args: { code: 'open("src/product.ts", encoding="utf-8", mode="w").write("x")\n' },
		};
		const decision = await getWorkflowMutationDecision(input);
		expect(decision.blocked).toBe(true);
		expect(decision.reason).toBe("phase-boundary");
		expect(decision.targets).toContain("src/product.ts");

		const readOnly = await getWorkflowMutationDecision({
			...input,
			args: { code: 'open("src/product.ts", encoding="utf-8", mode="r").read()\n' },
		});
		expect(readOnly.blocked).toBe(false);
	});

	it("blocks python writes into runtime-owned .gjc state", async () => {
		const cwd = await makeTempRoot();
		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("python"),
			args: { code: 'write(".gjc/state/skill-active-state.json", "{}")\n' },
		});
		expect(decision.blocked).toBe(true);
		expect(decision.reason).toBe("workflow-state-target");
		expect(decision.message).toContain("runtime-owned");
	});

	it("blocks a qualified copy or rename destination when a gap precedes the attribute", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const cases: Array<[string, unknown]> = [
			["python", { code: 'shutil .copy("/tmp/a.md", "src/product.ts")\n' }],
			["python", { code: 'os .rename("/tmp/a.md", "src/product.ts")\n' }],
			["python", { code: 'shutil\\\n.copy("/tmp/a.md", "src/product.ts")\n' }],
			["eval", { cells: [{ language: "js", code: 'fs .renameSync("/tmp/a.md", "src/product.ts")\n' }] }],
		];
		for (const [name, args] of cases) {
			const input = { cwd, sessionId: "session-a", tool: tool(name), args };
			await expect(assertWorkflowMutationAllowed(input)).rejects.toBeInstanceOf(ToolError);
			const decision = await getWorkflowMutationDecision(input);
			expect(decision.blocked, `${name} ${JSON.stringify(args)}`).toBe(true);
			expect(decision.targets, `${name} ${JSON.stringify(args)}`).toContain("src/product.ts");
			expect(decision.reason).toBe("phase-boundary");
		}
		const scratch = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("python"),
			args: { code: 'shutil .copy("/tmp/a.md", "/tmp/b.md")\n' },
		});
		expect(scratch.blocked).toBe(false);
		expect(scratch.targets).toContain("/tmp/b.md");

		await writeActiveSkill(cwd, "autoresearch", "research");
		const research = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("python"),
			args: { code: 'os .rename("/tmp/a.md", "src/product.ts")\n' },
		});
		expect(research.blocked).toBe(true);
		expect(research.targets).toContain("src/product.ts");
		expect(research.message).toContain("research-only");
	});

	it("still allows a gapped qualified copy when planning is inactive", async () => {
		const cwd = await makeTempRoot();
		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("python"),
			args: { code: 'shutil .copy("/tmp/a.md", "src/product.ts")\n' },
		});
		expect(decision.blocked).toBe(false);
	});

	it("fails closed when an open mode is a non-literal variable", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const code of [
			'encoding = "w"; open("src/product.ts", encoding).write("x")\n',
			'open("src/product.ts", mode=encoding).write("x")\n',
		]) {
			const input = { cwd, sessionId: "session-a", tool: tool("python"), args: { code } };
			await expect(assertWorkflowMutationAllowed(input)).rejects.toBeInstanceOf(ToolError);
			const decision = await getWorkflowMutationDecision(input);
			expect(decision.blocked, code).toBe(true);
			expect(decision.reason, code).toBe("unknown-target");
		}
	});

	it("blocks Path writes and an unresolved Path receiver", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const code of [
			'Path("src", "product.ts").write_text("x")\n',
			'Path("src", "product.ts").write_bytes(b"x")\n',
			'Path("src", "product.ts").touch()\n',
		]) {
			const input = { cwd, sessionId: "session-a", tool: tool("python"), args: { code } };
			await expect(assertWorkflowMutationAllowed(input)).rejects.toBeInstanceOf(ToolError);
			const decision = await getWorkflowMutationDecision(input);
			expect(decision.blocked, code).toBe(true);
			expect(decision.targets, code).toContain("src/product.ts");
			expect(decision.reason, code).toBe("phase-boundary");
		}
		const dynamic = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("python"),
			args: { code: 'Path(root, "product.ts").write_text("x")\n' },
		});
		expect(dynamic.blocked).toBe(true);
		expect(dynamic.reason).toBe("unknown-target");
		for (const code of [
			'from pathlib import Path as P; P("src/product.ts").write_text("x")\n',
			'from pathlib import Path; Path("src").joinpath("product.ts").write_text("x")\n',
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("python"),
				args: { code },
			});
			expect(decision.blocked, code).toBe(true);
			expect(decision.reason, code).toBe("unknown-target");
		}
	});

	it("resets a Path receiver at a later absolute component before the scratch check", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const productPath = path.join(cwd, "src", "product.ts");
		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("python"),
			args: { code: `Path("/tmp", ${JSON.stringify(productPath)}).write_text("x")\n` },
		});
		expect(decision.blocked).toBe(true);
		expect(decision.reason).toBe("phase-boundary");
		expect(decision.targets).toContain(productPath);
	});

	it("keeps planning Bash interpreter and inline-program boundaries fail-closed", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plan workspace-"));
		tempRoots.push(cwd);
		await writeActiveSkill(cwd, "ralplan", "planner");
		const scratch = path.join(os.tmpdir(), `gjc-plan-multi-write-${process.pid}.txt`);
		const escapedScratch = path.join(os.tmpdir(), `gjc-plan-escaped\\${process.pid}.txt`);
		const spacedProjectTarget = path.join(cwd, "src", "product.ts");
		const cases: Array<{
			name: string;
			command: string;
			blocked: boolean;
			reason?: "phase-boundary" | "unknown-target";
			target?: string;
		}> = [
			{
				name: "ANSI-C quoted Python write source",
				command: `python3 -c $'open("src/product.ts","w").write("PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Python exec-wrapped write source",
				command: `python3 -c 'exec(${JSON.stringify('open("src/product.ts","w").write("PWNED")')})'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Python eval-wrapped write source",
				command: `python3 -c 'eval(${JSON.stringify('open("src/product.ts","w").write("PWNED")')})'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Ruby attached -e write source",
				command: `ruby -e'File.open("src/product.ts","w").write("PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Ruby eval-wrapped write source",
				command: `ruby -e 'eval("File.open(\\"src/product.ts\\",\\"w\\").write(\\"PWNED\\")")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Ruby reflective send source",
				command: `ruby -e 'send(:eval, "File.open(\\"src/product.ts\\",\\"w\\").write(\\"PWNED\\")")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Node eval-wrapped write source",
				command: `node -e 'eval(${JSON.stringify('require("fs").writeFileSync("src/product.ts","PWNED")')})'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Node Function constructor source",
				command: `node -e 'Function(${JSON.stringify('require("fs").writeFileSync("src/product.ts","PWNED")')})()'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Node dynamic eval inside an interpolated template",
				command: "node -e '`" + "$" + "{eval(command)}`'",
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Node filesystem module loaded by string",
				command: `node -e 'const fs = require("node:fs"); fs.writeFileSync("src/product.ts", "PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "filesystem module loading is opaque without a visible write call",
				command: `node -e 'require("node:fs/promises")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Perl eval source",
				command: `perl -e 'eval $payload'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "PHP eval source",
				command: `php -r 'eval($payload);'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Lua dynamic load source",
				command: `lua -e 'loadstring(payload)()'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Lua filesystem module loaded by string",
				command: `lua -e 'require("io")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Bash -c eval source",
				command: `bash -c 'eval "$payload"'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "dynamic execution spelling inside an interpreter string span",
				command: `ruby -e 'puts "eval(\\"File.open(\\"src/product.ts\\",\\"w\\")\\")"'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "PHP direct file write API",
				command: `php -r 'file_put_contents("src/product.ts", "PWNED");'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "opaque AWK file program",
				command: "awk -f scripts/plan.awk",
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "opaque long-option AWK file program",
				command: "awk --file=scripts/plan.awk",
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "AWK assignment option before quoted program",
				command: `awk -v x=1 'BEGIN { print "PWNED" > "src/product.ts" }' input`,
				blocked: true,
				reason: "phase-boundary",
				target: "src/product.ts",
			},
			{
				name: "GNU AWK alias direct output write",
				command: `gawk 'BEGIN { print "PWNED" > "src/product.ts" }' input`,
				blocked: true,
				reason: "phase-boundary",
				target: "src/product.ts",
			},
			{
				name: "MAWK alias direct output write",
				command: `mawk 'BEGIN { print "PWNED" > "src/product.ts" }' input`,
				blocked: true,
				reason: "phase-boundary",
				target: "src/product.ts",
			},
			{
				name: "AWK command-pipe write",
				command: `awk 'BEGIN { print "PWNED" | "tee src/product.ts" }'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "AWK system command execution",
				command: `awk 'BEGIN { system("touch src/product.ts") }'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "AWK second statement in quoted program",
				command: `awk 'BEGIN { print 1; print "PWNED" > "src/product.ts" }' input`,
				blocked: true,
				reason: "phase-boundary",
				target: "src/product.ts",
			},
			{
				name: "sed addressed write after regex address",
				command: "sed -n '/needle/w src/product.ts' input",
				blocked: true,
				reason: "phase-boundary",
				target: "src/product.ts",
			},
			{
				name: "sed write in a conditional command position",
				command: "if sed -n 'w src/product.ts' <<<x; then :; fi",
				blocked: true,
				reason: "phase-boundary",
				target: "src/product.ts",
			},
			{
				name: "sed write after a semicolon in the quoted program",
				command: "sed -n '1p;w src/product.ts' packages/coding-agent/package.json",
				blocked: true,
				reason: "phase-boundary",
				target: "src/product.ts",
			},
			{
				name: "sed destination is not truncated to a neutral temporary prefix",
				command: `sed -n 'w ${spacedProjectTarget}' input`,
				blocked: true,
				reason: "phase-boundary",
				target: spacedProjectTarget,
			},
			{
				name: "later sed destination after a temporary first destination",
				command: `sed -n 'w ${scratch};w src/product.ts' input`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Python compile-only source remains inert",
				command: `python3 -c 'compile(${JSON.stringify('open("src/product.ts","w").write("x")')}, "<string>", "exec")'`,
				blocked: false,
			},
			{
				name: "Python pathlib Path.write_text",
				command: `python3 -c 'from pathlib import Path; Path("src/product.ts").write_text("PWNED")'`,
				blocked: true,
				reason: "phase-boundary",
				target: "src/product.ts",
			},
			{
				name: "Python pathlib Path imported under an alias fails closed",
				command: `python3 -c 'from pathlib import Path as P; P("src/product.ts").write_text("PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Python chained pathlib write fails closed",
				command: `python3 -c 'from pathlib import Path; Path("src").joinpath("product.ts").write_text("PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Python built-in open for writing",
				command: `python3 -c 'open("src/product.ts", "w").write("PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Python pathlib Path.write_bytes",
				command: `python3 -c 'from pathlib import Path; Path("src/product.ts").write_bytes(b"PWNED")'`,
				blocked: true,
				reason: "phase-boundary",
				target: "src/product.ts",
			},
			{
				name: "Python pathlib.Path.open for writing",
				command: `python3 -c 'import pathlib; pathlib.Path("src/product.ts").open("w")'`,
				blocked: true,
				reason: "phase-boundary",
				target: "src/product.ts",
			},
			{
				name: "Python pathlib Path.touch retains the legacy write-API denial",
				command: `python3 -c 'from pathlib import Path; Path("src/product.ts").touch()'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Python tempfile file write retains the legacy write-API denial",
				command: `python3 -c $'import tempfile\\nf=tempfile.NamedTemporaryFile(dir=".", delete=False)\\nf.write(b"x")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Python non-path write API retains the legacy denial",
				command: `python3 -c 'fwrite("src/product.ts", "PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Node process.stdout.write rebound to a file writer",
				command: `node -e 'process.stdout.write=process.getBuiltinModule("fs")["writeFileSync"],process.stdout.write("src/product.ts","PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Node bracketed process.stdout access rebound to a file writer",
				command: `node -e 'process["stdout"].write=process.getBuiltinModule("fs").writeFileSync;process.stdout.write("src/product.ts","PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Node computed process stream method rebound to a file writer",
				command: `node -e 'const stream="stdout";process[stream].write=process.getBuiltinModule("fs").writeFileSync;process.stdout.write("src/product.ts","PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Node console method rebound to a file writer",
				command: `node -e 'console.log=process.getBuiltinModule("fs").writeFileSync;console.log("src/product.ts","PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Node computed console method rebound to a file writer",
				command: `node -e 'const method="log";global.console[method]=process.getBuiltinModule("fs").writeFileSync;global.console[method]("src/product.ts","PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Python stdout method rebound to a file writer",
				command: `python3 -c 'import sys; sys.stdout.write=open("src/product.ts","w").write; sys.stdout.write("PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Python write API name in inert output text",
				command: `python3 -c "print('shutil.copy(')"`,
				blocked: false,
			},
			{
				name: "Node write API name in inert output text",
				command: `node -e "console.log('writeFileSync(')"`,
				blocked: false,
			},
			{
				name: "Python API name in comment",
				command: `python3 -c "print(1) # shutil.copy('stage/pwn.txt','src/product.ts')"`,
				blocked: false,
			},
			{
				name: "Node write API name in comment",
				command: `node -e "/* writeFileSync('src/product.ts','x') */ console.log(1)"`,
				blocked: false,
			},
			{
				name: "Python literal read-only os.system command",
				command: `python3 -c "import os; os.system('ls')"`,
				blocked: false,
			},
			{
				name: "sed input filename that resembles a write script",
				command: "sed -n '1p' 'w src/product.ts'",
				blocked: false,
			},
			{
				name: "conditional read-only sed remains allowed",
				command: "if sed -n '1p' input; then :; fi",
				blocked: false,
			},
			{
				name: "quoted sed command text is not a command",
				command: `echo 'prefix; sed -n "w src/product.ts"'`,
				blocked: false,
			},
			{
				name: "AWK quoted string comparison rather than redirection",
				command: `awk '$1 > "m" { print }' input`,
				blocked: false,
			},
			{
				name: "GNU AWK informational version query",
				command: "awk -W version",
				blocked: false,
			},
			{
				name: "GNU AWK lint option and read-only program",
				command: "awk -W lint '$1 > 5 { print $1 }' input",
				blocked: false,
			},
			{
				name: "GNU AWK POSIX compatibility option and read-only program",
				command: "awk -W posix '$1 > 5 { print $1 }' input",
				blocked: false,
			},
			{
				name: "AWK escaped temporary destination",
				command: `awk 'BEGIN { printf "x" > ${JSON.stringify(escapedScratch)} }'`,
				blocked: false,
			},
			{
				name: "Lua read-only inline source",
				command: `lua -e 'print("ok")'`,
				blocked: false,
			},
			{
				name: "Perl explicit read-mode open",
				command: `perl -e 'open(F, "<", "src/product.ts"); print 1;'`,
				blocked: false,
			},
			{
				name: "Perl list-form open for writing",
				command: `perl -e 'open F, ">", "src/product.ts"; print F "PWNED";'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Perl list-form open with a variable mode fails closed",
				command: `perl -e 'open F, $mode, "src/product.ts"; print F "PWNED";'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Perl list-form read-mode open stays allowed",
				command: `perl -e 'open F, "<", "src/product.ts"; print 1;'`,
				blocked: false,
			},
			{
				name: "Node stream method rebound reflectively then written",
				command: `node -e 'Object.assign(process.stdout,{write:process.getBuiltinModule("fs").writeFileSync});process.stdout.write("src/product.ts","PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Node stream method defined reflectively then written",
				command: `node -e 'Object.defineProperty(process.stdout,"write",{value:process.getBuiltinModule("fs").writeFileSync});process.stdout.write("src/product.ts","PWNED")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "sed GNU e command hides a shell redirection",
				command: `printf x | sed 'e : > src/product.ts'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "sed substitution e flag runs the replacement as a shell command",
				command: `printf x | sed 's|x|: > src/product.ts|e'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Python os.system captured as a callable then invoked",
				command: `python3 -c 'import os; run=os.system; run("printf PWNED > src/product.ts")'`,
				blocked: true,
				reason: "unknown-target",
			},
			{
				name: "Python os module aliased then system invoked",
				command: `python3 -c 'import os as o; o.system("printf PWNED > src/product.ts")'`,
				blocked: true,
				reason: "unknown-target",
			},
		];

		for (const scenario of cases) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command: scenario.command },
			});
			expect(decision.blocked, scenario.name).toBe(scenario.blocked);
			if (scenario.reason) expect(decision.reason, scenario.name).toBe(scenario.reason);
			if (scenario.target) expect(decision.targets, scenario.name).toContain(scenario.target);
		}
	});

	it("blocks planning bash writes outside the old denylist and still allows read-only commands", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const scratch = path.join(os.tmpdir(), `gjc-plan-bash-${process.pid}.txt`);
		const escapedScratch = path.join(os.tmpdir(), `gjc-plan-escaped\\${process.pid}.txt`);
		const unknownTargetCommands = new Set([
			`python3 -c 'exec("open(\\"src/product.ts\\",\\"w\\").write(\\"PWNED\\")")'`,
			`python3 -c 'eval("open(\\"src/product.ts\\",\\"w\\").write(\\"PWNED\\")")'`,
			`python3 -c '__import__("os").system("echo PWNED > src/product.ts")'`,
			`python3 -c 'import importlib; importlib.import_module("project_plugin")'`,
			`python3 -c 'import runpy; runpy.run_path("src/payload.py")'`,
			`python3 -c 'spec.loader.exec_module(module)'`,
			`python3 -c 'import pathlib; pathlib.Path("src/product.ts").open(mode=mode)'`,
			`python3 -c 'open("src/product.ts", mode=mode).write("PWNED")'`,
			`node -e"require('fs').appendFileSync('src/product.ts','x')"`,
			`perl -e'open(F,">","src/product.ts"); print F "PWNED";'`,
			`ruby -e'File.open("src/product.ts","w").write("PWNED")'`,
		]);
		const blocked = [
			...unknownTargetCommands,
			"sed -n 'w src/product.ts' stage/pwn.txt",
			"sed -e 'w src/product.ts' stage/pwn.txt",
			"sed -n '/needle/w src/product.ts' input",
			"sed -n 's/a/b/w src/product.ts' stage/pwn.txt",
			`sed -n 'w ${scratch};w src/product.ts' input`,
			`python3 -c "import shutil; shutil.copy('stage/pwn.txt','src/product.ts')"`,
			`python3 -c $'open("src/product.ts","w").write("PWNED")'`,
			`python3 -c "import os; os.system('printf PWNED > src/product.ts')"`,
			`python3 -c "import os; os.system(command)"`,
			`node -e "require('fs').appendFileSync('src/product.ts','x')"`,
			`perl -e 'open(F,">","src/product.ts"); print F "PWNED";'`,
			`awk 'BEGIN{printf "PWNED" > "src/product.ts"}'`,
			`awk -v x=1 'BEGIN { print "PWNED" > "src/product.ts" }' input`,
			`awk 'BEGIN { print 1; print "PWNED" > "src/product.ts" }' input`,
			"awk -W unsupported-extension",
			`if awk 'BEGIN { print "PWNED" > "src/product.ts" }' input; then :; fi`,
			`sed -n '/x/e printf PWNED > src/product.ts' input`,
			`sed -n '/needle/e touch src/product.ts' input`,
			`if python3 -c 'open("src/product.ts","w").write("x")'; then :; fi`,
			`while true; do node -e "require('fs').writeFileSync('src/product.ts','x')"; done`,
			`until ruby -e 'File.write("src/product.ts","x")'; do :; done`,
			"ln -sf stage/pwn.txt src/product.ts",
			`python3 -c "import os; os.symlink('stage/pwn.txt','src/pwn-link.ts')"`,
		];
		for (const command of blocked) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked, command).toBe(true);
			if (unknownTargetCommands.has(command)) expect(decision.reason, command).toBe("unknown-target");
		}
		const systemWrite = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("bash"),
			args: { command: `python3 -c "import os; os.system('printf PWNED > src/product.ts')"` },
		});
		expect(systemWrite.targets).toContain("src/product.ts");
		const dynamicSystem = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("bash"),
			args: { command: `python3 -c "import os; os.system(command)"` },
		});
		expect(dynamicSystem.reason).toBe("unknown-target");
		await expect(
			assertWorkflowMutationAllowed({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command: "sed -n 'w src/product.ts' stage/pwn.txt" },
			}),
		).rejects.toBeInstanceOf(ToolError);

		for (const command of [
			"sed -n '1p' src/product.ts",
			"sed -n '/needle/p' 'w src/product.ts'",
			"sed -n '1p' 'w src/product.ts'",
			"sed -e '1p' 'w src/product.ts'",
			"sed -n '1,80p' packages/coding-agent/src/skill-state/workflow-mutation-guard.ts",
			"sed -n 's/a/b/p' src/product.ts",
			"awk '$1 > 5 {print $1}' src/product.ts",
			`awk '$1 > "m" { print }' input`,
			"awk -W version",
			"awk -W lint '$1 > 5 { print $1 }' input",
			`awk 'BEGIN { print 1 # > "src/product.ts"\n}' input`,
			`awk -v x=1 'BEGIN { print x }' input`,
			`if awk '$1 > "m" { print }' input; then :; fi`,
			`python3 -c "import os; os.system('ls')"`,
			`python3 -c "import pathlib; pathlib.Path('src/product.ts').open('r').read()"`,
			`python3 -c 'from pathlib import Path as P; P("src").joinpath("product.ts").open("r").read()'`,
			`python3 -c 'from pathlib import Path; Path("/tmp/ralplan-note.md").write_text("x")'`,
			`python3 -c $'print("open(")'`,
			`python3 -c "print('writeFileSync(')"`,
			`python3 -c "print('shutil.copy(')"`,
			`python3 -c "print(1) # shutil.copy('stage/pwn.txt','src/product.ts')"`,
			`python3 -c "print(1)"`,
			`node -e "console.log('appendFileSync(')"`,
			`node -e "/* appendFileSync('src/product.ts','x') */ console.log(1)"`,
			`node -e "console.log(1)"`,
			`node -e 'process.stdout.write("status")'`,
			`node -e 'process["exitCode"]=1;console.log("status")'`,
			`node -e "console.log('process.stdout.write = fs.writeFileSync')"`,
			`perl -e 'print 1'`,
			`ruby -e'puts "open("'`,
			"ls src/product.ts",
			"readlink src/product.ts",
			`ln -sf stage/pwn.txt ${scratch}`,
			`sed -n 'w ${scratch}' src/product.ts`,
			`awk 'BEGIN { printf "x" > ${JSON.stringify(scratch)} }'`,
			`awk 'BEGIN { printf "x" > ${JSON.stringify(escapedScratch)} }'`,
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked, command).toBe(false);
		}
		await assertWorkflowMutationAllowed({
			cwd,
			sessionId: "session-a",
			tool: tool("bash"),
			args: { command: "sed -n '1p' src/product.ts" },
		});

		const idle = await makeTempRoot();
		const outsidePlanning = await getWorkflowMutationDecision({
			cwd: idle,
			sessionId: "session-a",
			tool: tool("bash"),
			args: { command: "ln -sf stage/pwn.txt src/product.ts" },
		});
		expect(outsidePlanning.blocked).toBe(false);
	});

	it("blocks sed writes whose destination contains spaces", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plan workspace-"));
		tempRoots.push(cwd);
		await writeActiveSkill(cwd, "ralplan", "planner");
		const destination = path.join(cwd, "src", "product.ts");
		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("bash"),
			args: { command: `sed -n 'w ${destination}' input` },
		});

		expect(decision.blocked).toBe(true);
		expect(decision.targets).toContain(destination);
	});

	it("allows a multi-part temp Path write and a non-writing Path read", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const code of [
			'Path("/tmp", "ralplan-note.md").write_text("x")\n',
			'Path("src", "product.ts").open("r").read()\n',
			'Path("src", "product.ts").read_text()\n',
			'open("src/product.ts", "r").read()\n',
			'open("src/product.ts", mode="r").read()\n',
			'open("src/product.ts", buffering=-1).read()\n',
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("python"),
				args: { code },
			});
			expect(decision.blocked, code).toBe(false);
		}
	});

	it("keeps generated write payloads blocked across equivalent shell quoting", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const guardContext = await readWorkflowGuardContext(cwd, { sessionId: "session-a" });
		const random = makeSeededRandom(0x6801);

		for (let sample = 0; sample < 12; sample++) {
			const target = `src/generated-${seededToken(random, 8)}.ts`;
			const content = seededToken(random, 10);
			const destination = JSON.stringify(target);
			const data = JSON.stringify(content);
			const scripts = [
				{
					interpreter: "python3 -c",
					source: `open(${destination}, "w").write(${data})`,
					target,
				},
				{
					interpreter: "python3 -c",
					source: `Path(${destination}).write_text(${data})`,
					target,
				},
				{
					interpreter: "python3 -c",
					source: `pathlib.Path(${destination}).write_bytes(b${data})`,
					target,
				},
				{
					interpreter: "node -e",
					source: `process.stdout.write = process.getBuiltinModule("fs").writeFileSync; process.stdout.write(${destination}, ${data})`,
					expectedReason: "unknown-target",
				},
				{
					interpreter: "node -e",
					source: `console.log = process.getBuiltinModule("fs").writeFileSync; console.log(${destination}, ${data})`,
					expectedReason: "unknown-target",
				},
			];

			for (const { interpreter, source, expectedReason, target: expectedTarget } of scripts) {
				const firstSplit = 1 + Math.floor(random() * (source.length - 2));
				const secondSplit = firstSplit + 1 + Math.floor(random() * (source.length - firstSplit - 1));
				const operands = [
					quoteBashSingle(source),
					quoteBashDouble(source),
					quoteBashAnsiC(source),
					quoteBashConcatenation(source, firstSplit, secondSplit),
				];
				let expectedVerdict: { blocked: boolean } | undefined;

				for (const operand of operands) {
					const command = `${interpreter} ${operand}`;
					const decision = await getWorkflowMutationDecision({
						cwd,
						sessionId: "session-a",
						guardContext,
						tool: tool("bash"),
						args: { command },
					});
					const verdict = { blocked: decision.blocked };
					expect(decision.blocked, command).toBe(true);
					if (expectedReason) expect(decision.reason, command).toBe(expectedReason);
					if (expectedTarget) {
						if (decision.reason === "phase-boundary") expect(decision.targets, command).toContain(expectedTarget);
						else expect(decision.reason, command).toBe("unknown-target");
					} else {
						expect(decision.reason, command).toBe("unknown-target");
					}
					if (expectedVerdict) expect(verdict, command).toEqual(expectedVerdict);
					else expectedVerdict = verdict;
				}
			}
		}
	});

	it("preserves the merge-base opaque interpreter-write denylist floor", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const guardContext = await readWorkflowGuardContext(cwd, { sessionId: "session-a" });
		const random = makeSeededRandom(0x6801_2026);
		// Exact BASH_OPAQUE_INTERPRETER_WRITE_RE from merge-base 3756eeec.
		// Generated inputs below are real writes, not inert string-literal matches.
		const mergeBaseOpaqueInterpreterWriteRe =
			/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:python3?|node|ruby)\b[^;&|\n]*(?:-c|-e)\b[^;&|\n]*(?:open\s*\(|writeFile(?:Sync)?\s*\(|\.write\s*\()/i;

		for (let sample = 0; sample < 8; sample++) {
			const target = `src/floor-${seededToken(random, 8)}.ts`;
			const content = seededToken(random, 10);
			const destination = JSON.stringify(target);
			const data = JSON.stringify(content);
			const scripts = [
				{ interpreter: "python3 -c", source: `open(${destination}, "w").write(${data})` },
				{ interpreter: "node -e", source: `require("fs").writeFileSync(${destination}, ${data})` },
				{ interpreter: "ruby -e", source: `File.open(${destination}, "w").write(${data})` },
			];

			for (const { interpreter, source } of scripts) {
				const operands = [quoteBashSingle(source), quoteBashDouble(source), quoteBashAnsiC(source)];
				for (const operand of operands) {
					const command = `${interpreter} ${operand}`;
					expect(mergeBaseOpaqueInterpreterWriteRe.test(command), command).toBe(true);
					const decision = await getWorkflowMutationDecision({
						cwd,
						sessionId: "session-a",
						guardContext,
						tool: tool("bash"),
						args: { command },
					});
					expect(decision.blocked, command).toBe(true);
				}
			}
		}
	});

	it("allows generated inert interpreter literals that resemble write APIs", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const guardContext = await readWorkflowGuardContext(cwd, { sessionId: "session-a" });
		const random = makeSeededRandom(0x1_6801_2026);
		const apiSpellings = ["open(", "writeFileSync(", "appendFileSync(", "shutil.copy(", ".write("];

		for (const api of apiSpellings) {
			for (let sample = 0; sample < 6; sample++) {
				const note = `${api} src/literal-${seededToken(random, 8)}.ts`;
				for (const language of ["python", "node"] as const) {
					const source =
						language === "python" ? `print(${JSON.stringify(note)})` : `console.log(${JSON.stringify(note)})`;
					const alternateSource = language === "python" ? `print('${note}')` : `console.log('${note}')`;
					const operands = [quoteBashSingle(source), quoteBashAnsiC(source), quoteBashDouble(alternateSource)];
					for (const operand of operands) {
						const command = `${language === "python" ? "python3 -c" : "node -e"} ${operand}`;
						const decision = await getWorkflowMutationDecision({
							cwd,
							sessionId: "session-a",
							guardContext,
							tool: tool("bash"),
							args: { command },
						});
						expect(decision.blocked, command).toBe(false);
					}
				}
			}
		}
	});

	// Regression tests for review findings from #6895
	it("blocks Node preload (-r) with stdout exemption", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		// Node -r loads code before -e, which is not scanned
		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("bash"),
			args: { command: `node -r /tmp/payload.cjs -e 'process.stdout.write("status")'` },
		});
		expect(decision.blocked).toBe(true);
	});

	it("blocks assignment aliases of output streams across shell quoting", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const guardContext = await readWorkflowGuardContext(cwd, { sessionId: "session-a" });
		const random = makeSeededRandom(0x6947);
		for (let sample = 0; sample < 8; sample++) {
			const alias = `s${seededToken(random, 6)}`;
			for (const stream of ["stdout", "stderr"]) {
				for (const source of [
					`const ${alias}=process.${stream};${alias}["write"]=process.getBuiltinModule("fs")["writeFileSync"];process.${stream}.write("src/product.ts","PWNED")`,
					`// status\rconst ${alias}=process.${stream};${alias}["write"]=process.getBuiltinModule("fs")["writeFileSync"];process.${stream}.write("src/product.ts","PWNED")`,
					`// status\u2028const ${alias}=process.${stream};${alias}["write"]=writer;process.${stream}.write("src/product.ts","PWNED")`,
					`// status\u2029const ${alias}=process.${stream};${alias}["write"]=writer;process.${stream}.write("src/product.ts","PWNED")`,
					`let ${alias};${alias}=process.${stream};Object.assign(${alias},{write:writer});process.${stream}.write("src/product.ts","PWNED")`,
					`const ${alias}=process["${stream}"];Reflect.set(${alias},"write",writer);process.${stream}.write("src/product.ts","PWNED")`,
					`const ${alias}=process./**/${stream};${alias}["write"]=writer;process.${stream}.write("src/product.ts","PWNED")`,
					`const ${alias}=process["std\\x${stream === "stdout" ? "6fut" : "65rr"}"];${alias}["write"]=writer;process.${stream}.write("src/product.ts","PWNED")`,
					`const ${alias}=process.std\\u00${stream === "stdout" ? "6fut" : "65rr"};${alias}["write"]=writer;process.${stream}.write("src/product.ts","PWNED")`,
					`\`\${(s=>s["write"]=process.getBuiltinModule("fs")["writeFileSync"])(process.${stream})}\`;process.${stream}.write("src/product.ts","PWNED")`,
					`const {${stream}:${alias}}=process;${alias}["write"]=writer;process.${stream}.write("src/product.ts","PWNED")`,
					`const ${alias}=Bun.${stream};${alias}["write"]=writer;Bun.${stream}.write("src/product.ts","PWNED")`,
					`const ${alias}=require("node:process").${stream};${alias}["write"]=process.getBuiltinModule("fs")["writeFileSync"];process.${stream}.write("src/product.ts","PWNED")`,
					`const ${alias}=globalThis["process"].${stream};${alias}["write"]=writer;process.${stream}.write("src/product.ts","PWNED")`,
					`const ${alias}=process.getBuiltinModule("process").${stream};${alias}["write"]=writer;process.${stream}.write("src/product.ts","PWNED")`,
					`const ${alias}=require/**/("node:process").${stream};${alias}["write"]=(p=>process.binding("fs")["writeFileUtf8"](p,"PWNED",577,438));process.${stream}.write("src/product.ts","PWNED")`,
					`const sink=(p,d)=>process.binding("fs")["writeFileUtf8"](p,d,577,438);\`\${/[}]/,(s=>s["write"]=sink)(process.${stream})}\`;process.${stream}.write("src/product.ts","PWNED")`,
					`const sink=(p,d)=>process.binding("fs")["writeFileUtf8"](p,d,577,438);let n=1;n++ / (s=>s["write"]=sink)(process.${stream}) / 1;process.${stream}.write("src/product.ts","PWNED")`,
					`const sink=(p,d)=>process.binding("fs")["writeFileUtf8"](p,d,577,438);let n=1;\`\${n-- / (s=>s["write"]=sink)(process.${stream}) / 1}\`;process.${stream}.write("src/product.ts","PWNED")`,
					`const sink=(p,d)=>process.binding("fs")["writeFileUtf8"](p,d,577,438);const holder={return:1};holder.return / (s=>s["write"]=sink)(process.${stream}) / 1;process.${stream}.write("src/product.ts","PWNED")`,
					`const sink=(p,d)=>process.binding("fs")["writeFileUtf8"](p,d,577,438);const ${alias}=module["require"]("node:process").${stream};${alias}["write"]=sink;process.${stream}.write("src/product.ts","PWNED")`,
					`const ${alias}=module["r"+"equire"]("node:process").${stream};${alias}["write"]=writer;process.${stream}.write("src/product.ts","PWNED")`,
					`const myFunction=({}).constructor.constructor;const ${alias}=myFunction("return process")()["${stream}"];${alias}["write"]=writer;process.${stream}.write("status")`,
					`const myFunction=({})./**/constructor./**/constructor;const ${alias}=myFunction("return process")()["${stream}"];${alias}["write"]=writer;process.${stream}.write("status")`,
					`const myFunction=({})/**/["constructor"]/**/["constructor"];const ${alias}=myFunction("return process")()["${stream}"];${alias}["write"]=writer;process.${stream}.write("status")`,
					`const r=/[//]/;const myFunction=({})["constructor"]["constructor"];const ${alias}=myFunction("return process")()["${stream}"];${alias}["write"]=writer;process.${stream}.write("status")`,
					`const myFunction=({})?.["constructor"]?.["constructor"];const ${alias}=myFunction("return process")()["${stream}"];${alias}["write"]=writer;process.${stream}.write("status")`,
					`const myFunction=({})[\`constructor\`][/**/"constructor"/**/];const ${alias}=myFunction("return process")()["${stream}"];${alias}["write"]=writer;process.${stream}.write("status")`,
					`console.log(\`\${({}).constructor.constructor("return 1")()}\`)`,
					`const ${alias}=pro\\u0063ess["${stream}"];${alias}["write"]=writer;process.${stream}.write("status")`,
					`const factory=require("node:module")["createRequire"];const loader=factory(process.cwd()+"/probe.js");const ${alias}=loader("node:process")["${stream}"];${alias}["write"]=writer;process.${stream}.write("status")`,
					...["globalThis", "global"].flatMap(root =>
						[`${root}["module"]["require"]`, `${root}["require"]`].map(
							loader =>
								`const ${alias}=${loader}("node:process")["${stream}"];${alias}["write"]=writer;process.${stream}.write("status")`,
						),
					),
					`const ${alias}=module["require"]("node:process")["${stream}"];${alias}["write"]=writer;process.${stream}.write("status")`,
					`\`\${/[}]/,(s=>s["write"]=writer)(process.${stream})}\`;process.${stream}.write("status")`,
					`let n=1;n++ / (s=>s["write"]=writer)(process.${stream}) / 1;process.${stream}.write("status")`,
					`const h={return:1};h. return / (s=>s["write"]=writer)(process.${stream}) / 1;process.${stream}.write("status")`,
					`if(true) if(true) /=/;(s=>s["write"]=writer)(process.${stream});/x/;process.${stream}.write("status")`,
					...["h.if()", "h. if()", "h./**/if()", "$if()", "h.catch()"].map(
						callee =>
							`const h={if:()=>1,catch:()=>1};const $if=()=>1;${callee} / (s=>s["write"]=writer)(process.${stream}) / 1;process.${stream}.write("status")`,
					),
					`const r=/"/;const h={return:1};h.return / (s=>s["write"]=writer)(process.${stream}) / 1;process.${stream}.write("status")`,
					...["\n", "\r", "\u2028", "\u2029"].map(
						terminator =>
							`const h={return:1};h.// note${terminator}return / (s=>s["write"]=writer)(process.${stream}) / 1;process.${stream}.write("status")`,
					),
					`console.log(\`\${(()=>{if(Boolean(1)) /[}}]/.test("}");const s=process.${stream};s["write"]=writer})()}\`);process.${stream}.write("status")`,
					`console.log(\`\${process.binding("fs")["writeFileUtf8"]("src/product.ts","PWNED",577,438)}\`)`,
				]) {
					for (const operand of [quoteBashSingle(source), quoteBashDouble(source), quoteBashAnsiC(source)]) {
						const command = `node -e ${operand}`;
						const decision = await getWorkflowMutationDecision({
							cwd,
							sessionId: "session-a",
							guardContext,
							tool: tool("bash"),
							args: { command },
						});
						expect(decision.blocked, command).toBe(true);
						expect(decision.reason, command).toBe("unknown-target");
					}
				}
			}
		}
	});

	it("allows ordinary output with unrelated arrows and inert stream aliases", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const source of [
			`const format = x => x.toUpperCase();process.stdout.write(format("status"))`,
			`const format = (x) => x;process.stderr.write(format("status"))`,
			`process.stdout.write(["status"].map(x => x).join(""))`,
			`/* const s=process.stdout;s.write=writer */ process.stdout.write("status")`,
			`console.log("const s=process.stdout;s.write=writer");process.stdout.write("status")`,
			`process.stdout.write(process.env.HOME)`,
			`const subprocess=0;console.log(subprocess)`,
			`const isBun=false;console.log(isBun)`,
			`const process$=0;console.log(process$)`,
			`process.stdout.write(\`status \${1}\`)`,
			`process.stdout.write(\`const s=process.stdout\`)`,
			`process.stdout.write(\`process complete \${1}\`)`,
			`console.log(\`cwd=\${process.cwd()}\`)`,
			`console.log(process.stdout.isTTY)`,
			`console.log(process.stderr.columns, process.stdout.rows)`,
			`process.stdout.write(\`status \${\`nested \${1}\`}\`)`,
			`console.log(\`\${/[{]/.test("{")}\`)`,
			`console.log(\`\${/[}]/.test("}")}\`)`,
			`console.log(\`\${8 / 2}\`)`,
			`console.log(\`\${({value: "}"}).value}\`)`,
			`console.log(\`require("node:process") \${1}\`)`,
			`console.log('require("process")')`,
			`/* require("node:process") */ process.stdout.write("status")`,
			`console.log(require/**/("node:path").basename("src/product.ts"))`,
			`const mygetBuiltinModule=1;console.log(mygetBuiltinModule)`,
			`console.log(\`\${1 /* } */ + 2}\`)`,
			`process.stdout.write(Array.from([1,2]).join(""))`,
			`console.log(Buffer.from("status","utf8"))`,
			`const holder={return:8};console.log(holder.return / 2)`,
			`console.log(module.filename, module.id, module.loaded)`,
			`console.log('module["require"]("node:process")')`,
			`function f(){return /x/.test("x")} console.log(f())`,
			`console.log(Math.max(1, 2) / 2)`,
			`const getBuiltinModule = id => id; console.log(getBuiltinModule("node:path"))`,
			`if (true) /x/.test("x"); console.log("inspection")`,
			`console.log(process.stdout.fd, process.stderr.fd)`,
			`const myFunction = value => value; console.log(myFunction("status"))`,
			`console.log(({constructor$:1}).constructor$)`,
			`console.log(["constructor"].join(""))`,
			`const data=/**/["constructor"];console.log(data.join(""))`,
			`const r=/[//]/;const data=["constructor"];console.log(r.test("/"),data.join(""))`,
			`console.log(8 / ["constructor"].length)`,
		]) {
			const command = `node -e ${quoteBashSingle(source)}`;
			expect((await decideBash(cwd, command)).blocked, command).toBe(false);
		}
	});

	it("applies the stream trust policy to JavaScript eval cells", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const [code, blocked] of [
			[`const s=process.stdout;s.write=fs.writeFileSync;s.write("src/product.ts","data")`, true],
			[`const s=process.stderr;s["write"]=writer;process.stderr.write("status")`, true],
			[`console.log("status");process.stdout.write("status")`, false],
			[`console.log(process.stdout.fd);await read("package.json")`, false],
			[`fs.writeFileSync("src/product.ts","data")`, true],
			[`const make=({})./**/constructor./**/constructor;make("return process")()`, true],
			[`const make=({})/**/["constructor"]/**/["constructor"];make("return process")()`, true],
			[`const r=/[//]/;const make=({})["constructor"]["constructor"];make("return process")()`, true],
			[`const make=({})?.["constructor"]?.["constructor"];make("return process")()`, true],
			[`const make=({})[\`con\${"structor"}\`][\`con\${"structor"}\`];make("return process")()`, true],
			[`globalThis["eval"]("process.stdout.write=write")`, true],
			[`global["eval"]("process.stderr.write=write")`, true],
			[`globalThis["Function"]("return process")()`, true],
			[`const make=({})[\`constructor\`][/**/"constructor"/**/];make("return process")()`, true],
			[`console.log(({constructor$:1}).constructor$)`, false],
			[`console.log(8 / ["constructor"].length)`, false],
		] as const) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("eval"),
				args: { cells: [{ language: "js", code }] },
			});
			expect(decision.blocked, code).toBe(blocked);
		}
	});

	it("blocks aliased stdout stream mutations", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		// Can reassign stdout through an alias and then write
		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("bash"),
			args: {
				command: `node -e '(s => (s.write=require("fs").writeFileSync, s.write("src/product.ts","PWNED")))(process.stdout)'`,
			},
		});
		expect(decision.blocked).toBe(true);
	});

	it("allows parenthesized Perl two-argument explicit reads", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const command of [
			`perl -e 'open(F, "<input.txt"); print <F>;'`,
			`perl -e "open(F, '<input.txt'); print <F>;"`,
			`perl -e "open F, '<input.txt'; print <F>;"`,
			`perl -e "open(F, '<', 'input.txt'); print <F>;"`,
			`perl -e 'open(F, "<",\n "input.txt"); print <F>;'`,
			`perl -e 'my %files = (input => "input.txt"); open(F, "<", $files{input}); print <F>;'`,
			`perl -e 'if (open F, "<", "input.txt") { print <F>; }'`,
			`perl -e 'open(my $fh, "<input.txt"); print <$fh>;'`,
			`perl -e 'open(main::F, "<", "input.txt");'`,
			`perl -e 'open(*F, "<", "input.txt");'`,
			`perl -e 'CORE::open(F, "<input.txt"); print <F>;'`,
			`perl -e 'CORE::open F, "<", "input.txt"; print <F>;'`,
			`perl -e 'print "use Project::Helper"; open(F, "<input.txt");'`,
			`perl -e 'my $use = 1; open(F, "<", "input.txt"); print 1;'`,
			`perl -e 'my $no = 1; open(F, "<input.txt"); print 1;'`,
			`printf '%s' PERL5OPT=-MConfig; perl -e 'open(F, "<input.txt");'`,
			`env printf '%s' PERL5OPT=-MConfig; perl -e 'open(F, "<input.txt");'`,
			`cat <<'DATA'\nPERL5OPT=-MConfig\nDATA\nperl -e 'open(F, "<input.txt");'`,
			String.raw`perl -e 'print "\$literal"; open(F, "<input.txt");'`,
			String.raw`perl -e 'print "mail\@example"; open(F, "<input.txt");'`,
			String.raw`perl -e 'print "\\\$literal"; open(F, "<input.txt");'`,
			String.raw`perl -e 'open F, "<input\\file"; print <F>;'`,
			String.raw`perl -e 'open(F, "<input\\file"); print <F>;'`,
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked, command).toBe(false);
		}
	});

	it("denies nonbuiltin Perl calls with read-looking open suffixes", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const source of [
			`Project::Helper::reopen(F, "<src/product.ts")`,
			`Project::Helper::réopen(F, "<src/product.ts")`,
			`reopen(F, "<src/product.ts")`,
			`Project::Helper::open(F, "<src/product.ts")`,
			`Project::Helper->open(F, "<src/product.ts")`,
			`Project::Helper -> open(F, "<src/product.ts")`,
			`Project::Helper -> # note\nopen(F, "<src/product.ts")`,
			`Project::Helper -> # first\n# second\nopen(F, "<src/product.ts")`,
			`Project::Helper:: # note\nopen(F, "<src/product.ts")`,
			`& # note\nopen(F, "<src/product.ts")`,
			`Project::Helper::CORE::open(F, "<src/product.ts")`,
			`Project::Helper -> CORE::open(F, "<src/product.ts")`,
			`CORE::GLOBAL::open(F, "<src/product.ts")`,
			`&open(F, "<src/product.ts")`,
		]) {
			const command = `perl -e ${quoteBashSingle(source)}`;
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked, command).toBe(true);
			expect(decision.reason, command).toBe("unknown-target");
		}
	});

	it("denies Perl imports that can override a bare read-looking open", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const command of [
			`PERL5LIB=lib perl -e 'use Project::Helper "open"; open(F, "<src/product.ts");'`,
			`PERL5LIB=lib perl -MProject::Helper -e 'Project::Helper::reopen(F, "<src/product.ts");'`,
			`PERL5LIB=lib perl -MProject::Helper=open -e 'open(F, "<src/product.ts");'`,
			`PERL5LIB=lib perl -wMProject::Helper=open -e 'open(F, "<src/product.ts");'`,
			String.raw`PERL5LIB=lib perl -\MProject::Helper=open -e 'open(F, "<src/product.ts");'`,
			String.raw`PERL5LIB=lib perl -w\MProject::Helper=open -e 'open(F, "<src/product.ts");'`,
			String.raw`PERL5LIB=lib perl -e 'open(F, "<src/product.ts");' -\MProject::Helper=open`,
			`PERL5LIB=lib perl -e 'print "@{[do { use Project::Helper qw(open); 1 }]}"; open(F, "<src/product.ts");'`,
			String.raw`PERL5LIB=lib perl -e 'print "\\@{[do { use Project::Helper qw(open); 1 }]}"; open(F, "<src/product.ts");'`,
			`PERL5LIB=lib perl -M Project::Helper=open -e 'open(F, "<src/product.ts");'`,
			`PERL5LIB=lib perl -mProject::Helper -e 'open(F, "<src/product.ts");'`,
			`PERL5OPT=-MPlanted PERL5LIB=lib perl -e 'open(F, "<src/product.ts");'`,
			`env PERL5OPT=-MPlanted PERL5LIB=lib perl -e 'open(F, "<src/product.ts");'`,
			`export PERL5OPT=-MPlanted; perl -e 'open(F, "<src/product.ts");'`,
			`export 'PERL5OPT=-MPlanted'; perl -e 'my $use = 1; open(F, "<src/product.ts");'`,
			`</dev/null PERL5OPT=-MPlanted; export PERL5OPT; perl -e 'my $use = 1; open(F, "<src/product.ts");'`,
			`< /dev/null PERL5OPT=-MPlanted; export PERL5OPT; perl -e 'my $use = 1; open(F, "<src/product.ts");'`,
			`2>&1 PERL5OPT=-MPlanted; export PERL5OPT; perl -e 'my $use = 1; open(F, "<src/product.ts");'`,
			`2>& 1 PERL5OPT=-MPlanted; export PERL5OPT; perl -e 'my $use = 1; open(F, "<src/product.ts");'`,
			`export "PERL5DB=Planted"; perl -e 'my $no = 1; open(F, "<src/product.ts");'`,
			`declare -x 'PERL5OPT=-MPlanted'; perl -e 'open(F, "<src/product.ts");'`,
			`readonly 'PERL5OPT=-MPlanted'; export PERL5OPT; perl -e 'open(F, "<src/product.ts");'`,
			`PERL5OPT=-MPlanted bash -c ${quoteBashSingle(`perl -e 'open(F, "<src/product.ts");'`)}`,
			`PERL5DB=Planted perl -d -e 'open(F, "<src/product.ts");'`,
			`PERL5LIB=lib perl -d:Planted -e 'open(F, "<src/product.ts");'`,
			`PERL5LIB=lib perl -wd:Planted -e 'open(F, "<src/product.ts");'`,
			`perl -e 'no Project::Helper; open(F, "<src/product.ts");'`,
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command },
			});
			expect(decision.blocked, command).toBe(true);
			expect(decision.reason, command).toBe("unknown-target");
		}
	});

	it("carries tool startup environment into nested Perl reads without blocking unrelated commands", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const perl = `perl -e 'my $use = 1; open(F, "<input.txt");'`;
		for (const command of [perl, `bash -c ${quoteBashSingle(perl)}`, `echo "$(${perl})"`, `printf safe`]) {
			for (const variable of ["PERL5OPT", "PERL5DB"]) {
				const decision = await getWorkflowMutationDecision({
					cwd,
					sessionId: "session-a",
					tool: tool("bash"),
					args: { command, env: { [variable]: "-MPlanted" } },
				});
				expect(decision.blocked, command).toBe(command !== "printf safe");
			}
		}
	});

	it("denies inherited Perl startup code without changing the test process environment", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const variable of ["PERL5OPT", "PERL5DB"]) {
			const result = Bun.spawnSync(
				[
					process.execPath,
					"--eval",
					`import { getWorkflowMutationDecision } from "@gajae-code/coding-agent/skill-state/workflow-mutation-guard";
const decision = await getWorkflowMutationDecision({
  cwd: ${JSON.stringify(cwd)}, sessionId: "session-a", tool: { name: "bash" },
  args: { command: 'perl -e \\'open(F, "<input.txt");\\'' }
});
process.stdout.write(JSON.stringify(decision));`,
				],
				{ env: { ...process.env, PERL5OPT: "", PERL5DB: "", [variable]: "-MPlanted" } },
			);
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			expect(JSON.parse(result.stdout.toString())).toMatchObject({ blocked: true, reason: "unknown-target" });
		}
	});

	it("preserves Perl open classification across seeded quoted delimiters", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const guardContext = await readWorkflowGuardContext(cwd, { sessionId: "session-a" });
		const random = makeSeededRandom(0x6947);
		for (const delimiter of [",", ")", "(", ";", "}", "\n"]) {
			const filename = `input-${seededToken(random, 8)}${delimiter}.txt`;
			const literal = `"${filename}"`;
			const space = " ".repeat(1 + Math.floor(random() * 3));
			for (const parenthesized of [false, true]) {
				for (const threeArgs of [false, true]) {
					for (const mode of ["<", ">", ">>", "+<", "<+", "|-"]) {
						const args = threeArgs ? `F,${space}"${mode}", ${literal}` : `F,${space}"${mode}${filename}"`;
						const source = parenthesized ? `open(${args}); print 1;` : `open ${args}; print 1;`;
						const command = `perl -e ${quoteBashAnsiC(source)}`;
						const decision = await getWorkflowMutationDecision({
							cwd,
							sessionId: "session-a",
							guardContext,
							tool: tool("bash"),
							args: { command },
						});
						expect(decision.blocked, command).toBe(mode !== "<");
					}
				}
			}
		}
	});

	it("denies variable, pipe, and unparsed Perl open operands", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const source of [
			`open(F, $mode, "input.txt");`,
			`open(F, "<$file");`,
			`open(F, "<@files");`,
			String.raw`open(F, "<input\nfile");`,
			String.raw`open(F, "<input\\$file");`,
			String.raw`open(F, "<input\\file|");`,
			`open(F, "<input.txt|");`,
			`open(F, "<input.txt";`,
			`open(F, "<input.txt);`,
			`open(F, "<" . $file);`,
			`open(F, "<input.txt",);`,
			`open(F, q{<input.txt});`,
			`open F, $mode or die "<";`,
			`open(F # , "<input.txt")\n, ">src/product.ts"); print F "PWNED";`,
			`open(q{F, "<input.txt")}, ">src/product.ts");`,
			`open(F, "<", "input.txt";`,
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command: `perl -e ${quoteBashSingle(source)}` },
			});
			expect(decision.blocked, source).toBe(true);
		}
	});

	it("classifies Perl open mode operand, not unrelated strings", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		// Perl open with unrelated die string should not be treated as read-only
		const decision = await getWorkflowMutationDecision({
			cwd,
			sessionId: "session-a",
			tool: tool("bash"),
			args: {
				command: `perl -e 'my $m = ">"; open F, $m, "src/product.ts" or die "<"; print F "PWNED"'`,
			},
		});
		expect(decision.blocked).toBe(true);
	});

	it("detects imported os.system callable aliases in Python", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const call = `run("printf PWNED > src/product.ts")`;
		const scripts = [
			`from os import system as run; ${call}`,
			`from os import system as unused; from os import system as run; ${call}`,
			`from os import system as run; from os import system as unused; ${call}`,
			`from os import system as unused\nfrom os import system as run\n${call}`,
			`from os import system as unused, system as run; ${call}`,
			`from os import getcwd, system as run, system as unused; ${call}`,
			`from os import (system as unused,\n # another alias\n system as run,); ${call}`,
			`from os import system as unused; from os import system; system("printf PWNED > src/product.ts")`,
			`from os import *; system("printf PWNED > src/product.ts")`,
			`# from os import system as unused\nfrom os import system as run; ${call}`,
			`note = "from os import system as unused"; from os import system as run; ${call}`,
			`from os import system as unused; from os import system as run; run(command)`,
			`from os import system as run\nprint(f"""{run("printf PWNED > src/product.ts")}""")`,
			`from os import system as run\nprint(f"""{run\\\n("printf PWNED > src/product.ts")}""")`,
			`from os import system as run\nprint(f"""{42:{run("printf PWNED > src/product.ts")}}""")`,
			`from os import system as run\nprint(f"""{f"{"x"}{run('printf PWNED > src/product.ts')}"}""")`,
			`note = """escaped \\""" marker"""; from os import system as run; ${call}`,
			`from os import system as unused, \\\n    system as run\n${call}`,
		];
		for (const script of scripts) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command: `python3 -c ${quoteBashSingle(script)}` },
			});
			expect({ script, blocked: decision.blocked, reason: decision.reason }).toEqual({
				script,
				blocked: true,
				reason: "unknown-target",
			});
		}
	});

	it("allows unused Python system imports and inert alias calls", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		for (const script of [
			`from os import system as unused; from os import system as run; print("status")`,
			`from os import system as run; # run(command)\nprint("status")`,
			`from os import system as run; print("run(command)")`,
			`from os import system as run; note = """run(command)"""; print(note)`,
			`note = "from os import system as run"; print("run(command)")`,
			`# from os import system as run\nrun = print; run("status")`,
			`from os import getcwd as run; print(run())`,
			`from os import system as unused, \\\n    system as run\nprint("status")`,
			`note = """escaped \\""" from os import system as run; run(command)"""; print(note)`,
			`from os import system as run; print(f"run(command)")`,
			`from os import system as run; print(f"{{run(command)}}")`,
			`from os import system as run; print(f"{42}: run(command)")`,
			`from os import system as run; print(f"""{'run(command)'}""")`,
			`from os import system as run; print(f"{42:run(command)}")`,
			`from os import system as run; print(f"{run}{(42)}")`,
			`from os import system as run; print(f"""{f"{"x"}{42}"}""")`,
			`from os import system as run; print(f"""{f"{'run(command)'}"}""")`,
		]) {
			const decision = await getWorkflowMutationDecision({
				cwd,
				sessionId: "session-a",
				tool: tool("bash"),
				args: { command: `python3 -c ${quoteBashSingle(script)}` },
			});
			expect({ script, blocked: decision.blocked }).toEqual({ script, blocked: false });
		}
	});

	it("keeps generated Python system aliases blocked at every import position", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, "ralplan", "planner");
		const guardContext = await readWorkflowGuardContext(cwd, { sessionId: "session-a" });
		const random = makeSeededRandom(6947);
		for (let sample = 0; sample < 12; sample++) {
			const names = Array.from({ length: 3 }, () => `alias_${seededToken(random, 8)}`);
			for (const name of names) {
				for (const imports of [
					names.map(alias => `from os import system as ${alias}`).join("; "),
					`from os import (${names.map(alias => `system as ${alias}`).join(", ")})`,
					`from os import ${names.map(alias => `system as ${alias}`).join(", \\\n    ")}`,
				]) {
					const script = `${imports}; ${name}("printf data > src/generated-${sample}.ts")`;
					const decision = await getWorkflowMutationDecision({
						cwd,
						sessionId: "session-a",
						guardContext,
						tool: tool("bash"),
						args: { command: `python3 -c ${quoteBashSingle(script)}` },
					});
					expect({ script, blocked: decision.blocked }).toEqual({ script, blocked: true });
				}
			}
		}
	});
});
