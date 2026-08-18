/**
 * End-to-end authorization check for the autoresearch research-only boundary.
 *
 * The guard authorizes by PATH, never by branch name: an active mission may
 * write its own research artifact (`autoresearch.sh` at the workdir root) and
 * nothing else — not product source, not anywhere in the repo tree, not even
 * on an `autoresearch/*` isolation branch. Branch isolation exists for
 * keep/discard bookkeeping; it is not mutation authority.
 *
 * Everything here runs against a real git repository with the production
 * helpers — nothing is stubbed or mocked.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import { ensureAutoresearchBranch, getCurrentAutoresearchBranch } from "../../src/autoresearch/git";
import { activeSnapshotPath, modeStatePath, sessionStateDir } from "../../src/gjc-runtime/session-layout";
import { getWorkflowMutationDecision } from "../../src/skill-state/workflow-mutation-guard";

const TEST_SESSION_ID = "session-branch-isolation";
const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function runGit(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/**
 * A real git repository with one baseline commit and a product file to target.
 * `.gjc/` is gitignored exactly as a real GJC repo does, so mission state files
 * never dirty the worktree (untracked-dirty trees force the documented degraded
 * branch path).
 */
function initRepo(): string {
	const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "gjc-autoresearch-branch-auth-"));
	tempRoots.push(dir);
	runGit(dir, "init", "-b", "main");
	runGit(dir, "config", "user.email", "test@example.com");
	runGit(dir, "config", "user.name", "Autoresearch Branch Auth Test");
	nodeFs.mkdirSync(path.join(dir, "src"), { recursive: true });
	nodeFs.writeFileSync(path.join(dir, "src", "product.ts"), "export const x = 1;\n", "utf8");
	nodeFs.writeFileSync(path.join(dir, ".gitignore"), ".gjc/\n", "utf8");
	runGit(dir, "add", ".");
	runGit(dir, "commit", "-m", "baseline");
	return dir;
}

/** Seed a live autoresearch mission posture the guard will resolve. */
async function activateMission(cwd: string, phase = "research"): Promise<void> {
	const now = new Date().toISOString();
	await fs.mkdir(sessionStateDir(cwd, TEST_SESSION_ID), { recursive: true });
	await Bun.write(
		activeSnapshotPath(cwd, TEST_SESSION_ID),
		`${JSON.stringify(
			{
				version: 1,
				active: true,
				skill: "autoresearch",
				phase,
				updated_at: now,
				active_skills: [
					{ skill: "autoresearch", phase, active: true, updated_at: now, session_id: TEST_SESSION_ID },
				],
			},
			null,
			2,
		)}\n`,
	);
	await Bun.write(
		modeStatePath(cwd, TEST_SESSION_ID, "autoresearch"),
		`${JSON.stringify({ active: true, current_phase: phase, session_id: TEST_SESSION_ID }, null, 2)}\n`,
	);
}

function writeTool(): AgentTool {
	return {
		name: "write",
		label: "write",
		description: "write",
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	} as AgentTool;
}

async function decideWrite(cwd: string, targetPath: string) {
	return getWorkflowMutationDecision({
		cwd,
		sessionId: TEST_SESSION_ID,
		tool: writeTool(),
		args: { path: targetPath, content: "export const x = 2;\n" },
	});
}

describe("autoresearch research-only authorization (real git, nothing stubbed)", () => {
	it("allows the mission harness artifact and blocks product mutation on the user's branch", async () => {
		const cwd = initRepo();
		await activateMission(cwd);

		expect(await getCurrentAutoresearchBranch(cwd)).toBeNull();

		// The one agent-writable research artifact: the harness at the workdir root.
		const harness = await decideWrite(cwd, "autoresearch.sh");
		expect(harness.blocked).toBe(false);

		// Product source stays blocked on the user's branch.
		const onMain = await decideWrite(cwd, "src/product.ts");
		expect(onMain.blocked).toBe(true);
		expect(onMain.message).toContain("research-only");
	});

	it("keeps product mutation blocked on the autoresearch isolation branch — branch name is not authorization", async () => {
		const cwd = initRepo();
		await activateMission(cwd);

		// Create the isolation branch through the real production helper.
		const ensured = await ensureAutoresearchBranch(cwd, "decode throughput");
		expect(ensured.ok).toBe(true);
		const branch = runGit(cwd, "branch", "--show-current");
		expect(branch.startsWith("autoresearch/")).toBe(true);
		expect(await getCurrentAutoresearchBranch(cwd)).toBe(branch);

		// Same mission, same tool, same product target — still blocked on the
		// branch. Isolation contains keep/discard bookkeeping, it does not turn
		// product edits into research.
		const onBranch = await decideWrite(cwd, "src/product.ts");
		expect(onBranch.blocked).toBe(true);
		expect(onBranch.message).toContain("research-only");

		// The harness artifact remains writable on the branch.
		const harness = await decideWrite(cwd, "autoresearch.sh");
		expect(harness.blocked).toBe(false);
	});

	it("does not authorize a lookalike harness path or nested harness copies", async () => {
		const cwd = initRepo();
		await activateMission(cwd);

		// Only the workdir-root harness is the mission artifact; copies planted
		// elsewhere in the tree are not.
		expect((await decideWrite(cwd, "src/autoresearch.sh")).blocked).toBe(true);
		expect((await decideWrite(cwd, "scripts/autoresearch.sh")).blocked).toBe(true);
		expect((await decideWrite(cwd, "docs/autoresearch.sh")).blocked).toBe(true);
	});

	it("releases mutation at a terminal mission phase even on the user's branch", async () => {
		const cwd = initRepo();
		await activateMission(cwd, "complete");

		expect(await getCurrentAutoresearchBranch(cwd)).toBeNull();
		expect((await decideWrite(cwd, "src/product.ts")).blocked).toBe(false);
	});
});
