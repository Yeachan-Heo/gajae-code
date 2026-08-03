import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import {
	activeSnapshotPath,
	modeStatePath,
	sessionStateDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { getWorkflowMutationDecision } from "@gajae-code/coding-agent/skill-state/workflow-mutation-guard";
import * as z from "zod/v4";

const tempRoots: string[] = [];
const sessionId = "ultratest-session";

const bashTool: AgentTool = {
	name: "bash",
	label: "Bash",
	description: "Run a shell command",
	parameters: z.object({ command: z.string() }),
	intent: "omit",
	execute: async () => ({ content: [{ type: "text", text: "unused" }] }),
};

function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

function gitWithEnvironment(cwd: string, args: string[], env: Record<string, string>): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

async function writeActiveSkill(cwd: string, skill: "team" | "ultratest" = "ultratest"): Promise<void> {
	const now = new Date().toISOString();
	await fs.mkdir(sessionStateDir(cwd, sessionId), { recursive: true });
	await Bun.write(
		activeSnapshotPath(cwd, sessionId),
		`${JSON.stringify({
			version: 1,
			active: true,
			skill,
			phase: skill === "ultratest" ? "verifying" : "running",
			updated_at: now,
			active_skills: [
				{
					skill,
					phase: skill === "ultratest" ? "verifying" : "running",
					active: true,
					updated_at: now,
					session_id: sessionId,
				},
			],
		})}\n`,
	);
	await Bun.write(
		modeStatePath(cwd, sessionId, skill),
		`${JSON.stringify({
			active: true,
			skill,
			current_phase: skill === "ultratest" ? "verifying" : "running",
			session_id: sessionId,
		})}\n`,
	);
}

async function createFixture(
	stagedPath = "src/example.test.ts",
	activeSkill: "team" | "ultratest" = "ultratest",
): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ultratest-commit-gate-"));
	tempRoots.push(cwd);
	git(cwd, ["init", "-q"]);
	git(cwd, ["config", "user.email", "ultratest@example.test"]);
	git(cwd, ["config", "user.name", "Ultratest"]);
	await fs.mkdir(path.dirname(path.join(cwd, stagedPath)), { recursive: true });
	await Bun.write(path.join(cwd, stagedPath), "export const verified = true;\n");
	git(cwd, ["add", stagedPath]);
	await writeActiveSkill(cwd, activeSkill);
	return cwd;
}

async function mutationDecision(cwd: string, command: string) {
	return await getWorkflowMutationDecision({ cwd, sessionId, tool: bashTool, args: { command } });
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("ultratest commit gate", () => {
	it("blocks an inline commit without an Ultratest-Verified trailer when a test is staged", async () => {
		const cwd = await createFixture();
		expect(git(cwd, ["diff", "--cached", "--name-only"])).toBe("src/example.test.ts");

		const decision = await mutationDecision(cwd, 'git commit -m "test: add verification"');

		expect(decision.blocked).toBe(true);
	});

	it("allows documented Ultratest-Verified trailer forms", async () => {
		for (const trailer of [
			"Ultratest-Verified: killed 3 / noted 1",
			"Ultratest-Verified: skip(no assertion change)",
		]) {
			const cwd = await createFixture();
			const decision = await mutationDecision(cwd, `git commit -m "test: add verification\n\n${trailer}"`);

			expect(decision.blocked).toBe(false);
		}
	});

	it("blocks an inline commit with two valid Ultratest-Verified trailer lines", async () => {
		const cwd = await createFixture();
		const decision = await mutationDecision(
			cwd,
			'git commit -m "test: add verification\n\nUltratest-Verified: killed 3 / noted 1\nUltratest-Verified: skip(no assertion change)"',
		);

		expect(decision.blocked).toBe(true);
	});

	it("blocks an inline commit with a valid and malformed Ultratest-Verified trailer line", async () => {
		const cwd = await createFixture();
		const decision = await mutationDecision(
			cwd,
			'git commit -m "test: add verification\n\nUltratest-Verified: killed 3 / noted 1\nUltratest-Verified: focused gate"',
		);

		expect(decision.blocked).toBe(true);
	});

	it("blocks an inline commit with text after an otherwise valid Ultratest-Verified trailer", async () => {
		const cwd = await createFixture();
		const decision = await mutationDecision(
			cwd,
			'git commit -m "test: add verification\n\nUltratest-Verified: killed 3 / noted 1\nFollow-up detail"',
		);

		expect(decision.blocked).toBe(true);
	});

	it("blocks an inline commit with an incomplete Ultratest-Verified trailer", async () => {
		const cwd = await createFixture();
		const decision = await mutationDecision(
			cwd,
			'git commit -m "test: add verification\n\nUltratest-Verified: focused gate"',
		);

		expect(decision.blocked).toBe(true);
	});
	it("blocks --message commits and Python test changes", async () => {
		const messageFlagFixture = await createFixture();
		const messageFlagDecision = await mutationDecision(
			messageFlagFixture,
			'git commit --message "test: add verification"',
		);
		expect(messageFlagDecision.blocked).toBe(true);

		const pythonFixture = await createFixture("tests/test_widget.py");
		expect(git(pythonFixture, ["diff", "--cached", "--name-only"])).toBe("tests/test_widget.py");
		const pythonDecision = await mutationDecision(pythonFixture, 'git commit -m "test: add widget"');
		expect(pythonDecision.blocked).toBe(true);
	});

	it("allows the explicit no-ultratest bypass assignment", async () => {
		const cwd = await createFixture();

		const decision = await mutationDecision(
			cwd,
			'GJC_ALLOW_NO_ULTRATEST=1 git commit -m "test: bypass verification"',
		);

		expect(decision.blocked).toBe(false);
	});

	it("uses literal Git context assignments to inspect the repository and index the commit will use", async () => {
		const cwdWithoutTest = await createFixture("src/example.ts");
		const targetWithTest = await createFixture();
		const targetDecision = await mutationDecision(
			cwdWithoutTest,
			`GIT_DIR=${path.join(targetWithTest, ".git")} GIT_WORK_TREE=${targetWithTest} git commit -m "test: redirected repository"`,
		);
		expect(targetDecision.blocked).toBe(true);

		const cwdWithTest = await createFixture();
		const targetWithoutTest = await createFixture("src/example.ts");
		const inverseDecision = await mutationDecision(
			cwdWithTest,
			`GIT_DIR=${path.join(targetWithoutTest, ".git")} GIT_WORK_TREE=${targetWithoutTest} git commit -m "test: redirected repository"`,
		);
		expect(inverseDecision.blocked).toBe(false);

		const alternateIndexCwd = await createFixture("src/example.ts");
		const alternateIndex = path.join(alternateIndexCwd, "alternate.index");
		await Bun.write(path.join(alternateIndexCwd, "src", "alternate.test.ts"), "export const alternate = true;\n");
		gitWithEnvironment(alternateIndexCwd, ["add", "src/alternate.test.ts"], { GIT_INDEX_FILE: alternateIndex });
		expect(git(alternateIndexCwd, ["diff", "--cached", "--name-only"])).toBe("src/example.ts");

		const alternateIndexDecision = await mutationDecision(
			alternateIndexCwd,
			`GIT_INDEX_FILE=${alternateIndex} git commit -m "test: alternate index"`,
		);
		expect(alternateIndexDecision.blocked).toBe(true);

		const primaryWorktree = await createFixture("src/example.ts");
		git(primaryWorktree, ["commit", "-m", "test: worktree baseline"]);
		const linkedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ultratest-linked-worktree-"));
		tempRoots.push(linkedRoot);
		const linkedWorktree = path.join(linkedRoot, "worktree");
		git(primaryWorktree, ["worktree", "add", "-q", "-b", path.basename(linkedRoot), linkedWorktree]);
		await Bun.write(path.join(linkedWorktree, "src", "linked.test.ts"), "export const linked = true;\n");
		git(linkedWorktree, ["add", "src/linked.test.ts"]);
		const linkedGitDir = git(linkedWorktree, ["rev-parse", "--path-format=absolute", "--git-dir"]);
		const commonDir = git(linkedWorktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

		const linkedWorktreeDecision = await mutationDecision(
			primaryWorktree,
			`GIT_DIR=${linkedGitDir} GIT_COMMON_DIR=${commonDir} GIT_WORK_TREE=${linkedWorktree} git commit -m "test: linked worktree"`,
		);
		expect(linkedWorktreeDecision.blocked).toBe(true);
	});

	it("does not execute a helper delivered by unsupported Git configuration assignments", async () => {
		const cwd = await createFixture();
		const marker = path.join(cwd, "fsmonitor-invoked");
		const helper = path.join(cwd, "fsmonitor-helper.sh");
		await Bun.write(helper, `#!/bin/sh\ntouch "${marker}"\n`);
		await fs.chmod(helper, 0o755);

		const decision = await mutationDecision(
			cwd,
			`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=${helper} git commit -m "test: injected fsmonitor"`,
		);

		expect(await pathExists(marker)).toBe(false);
		expect(decision.blocked).toBe(false);
	});

	it("does not create trace output for unsupported Git environment assignments", async () => {
		const cwd = await createFixture();
		const trace = path.join(cwd, "trace.json");

		const decision = await mutationDecision(cwd, `GIT_TRACE2_EVENT=${trace} git commit -m "test: trace output"`);

		expect(await pathExists(trace)).toBe(false);
		expect(decision.blocked).toBe(false);
	});

	it("suppresses repository-configured helpers during staged-test inspection", async () => {
		const cwd = await createFixture();
		const marker = path.join(cwd, "fsmonitor-invoked");
		const helper = path.join(cwd, "fsmonitor-helper.sh");
		await Bun.write(helper, `#!/bin/sh\ntouch "${marker}"\n`);
		await fs.chmod(helper, 0o755);
		git(cwd, ["config", "core.fsmonitor", helper]);

		const decision = await mutationDecision(cwd, 'git commit -m "test: local fsmonitor"');

		expect(decision.blocked).toBe(true);
		expect(await pathExists(marker)).toBe(false);
	});

	it("fails open for nonliteral, operator, and ambiguous commit forms", async () => {
		const cwd = await createFixture();
		for (const command of [
			"git commit -F message.txt",
			'git commit -m "$(cat message.txt)"',
			'COMMIT_MESSAGE="test: from environment" git commit -m "$COMMIT_MESSAGE"',
			'git commit -m "test: add verification" | tee commit.out',
			'git commit -m "unterminated',
			"git commit --amend",
		]) {
			const decision = await mutationDecision(cwd, command);
			expect(decision.blocked).toBe(false);
		}
	});

	it("allows an unverified inline commit when no test file is staged", async () => {
		const cwd = await createFixture("src/example.ts");
		expect(git(cwd, ["diff", "--cached", "--name-only"])).toBe("src/example.ts");

		const decision = await mutationDecision(cwd, 'git commit -m "feat: change implementation"');

		expect(decision.blocked).toBe(false);
	});

	it("allows an unverified inline commit when another workflow is active", async () => {
		const cwd = await createFixture("src/example.test.ts", "team");

		const decision = await mutationDecision(cwd, 'git commit -m "test: team workflow"');

		expect(decision.blocked).toBe(false);
	});

	it("blocks an unverified inline commit when a staged test deletion is the only change", async () => {
		const cwd = await createFixture();
		git(cwd, ["commit", "-m", "test: fixture baseline"]);
		git(cwd, ["rm", "src/example.test.ts"]);
		expect(git(cwd, ["diff", "--cached", "--name-status"])).toBe("D\tsrc/example.test.ts");

		const decision = await mutationDecision(cwd, 'git commit -m "test: remove verification"');

		expect(decision.blocked).toBe(true);
	});
});
