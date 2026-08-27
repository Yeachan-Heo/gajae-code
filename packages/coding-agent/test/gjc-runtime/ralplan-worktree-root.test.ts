import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runNativeRalplanCommand } from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";
import { runRalplanCliCommand } from "../../src/commands/ralplan";
import ralplanPersistenceTemplate from "../../src/prompts/agent-fragments/ralplan-persistence.md" with { type: "text" };

const tempRoots: string[] = [];
const recursiveForce = { recursive: true, force: true } as const;

let priorSessionId: string | undefined;
beforeAll(() => {
	priorSessionId = process.env.GJC_SESSION_ID;
});
afterAll(async () => {
	if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
	else delete process.env.GJC_SESSION_ID;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, recursiveForce)));
});

async function tempDir(prefix = "gjc-ralplan-wt-"): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

async function git(args: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
	}
}

async function gitText(args: string[], cwd: string, input?: string): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdin: input === undefined ? undefined : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (input !== undefined) {
		proc.stdin.write(input);
		proc.stdin.end();
	}
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	return stdout.trim();
}

/** Two scratch git repos: an intended target worktree and an unrelated dispatcher cwd. */
async function initRepo(prefix?: string): Promise<string> {
	const root = await tempDir(prefix);
	await git(["init"], root);
	await git(
		["-c", "user.email=test@gjc.local", "-c", "user.name=gjc-test", "commit", "--allow-empty", "-m", "init"],
		root,
	);
	return root;
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

function statePath(root: string, sessionId: string): string {
	return path.join(root, ".gjc", `_session-${sessionId}`, "state", "ralplan-state.json");
}

function runDir(root: string, sessionId: string, runId: string): string {
	return path.join(root, ".gjc", `_session-${sessionId}`, "plans", "ralplan", runId);
}

function hudPath(root: string, sessionId: string): string {
	return path.join(root, ".gjc", `_session-${sessionId}`, "state", "skill-active-state.json");
}

function activeEntryPath(root: string, sessionId: string): string {
	return path.join(root, ".gjc", `_session-${sessionId}`, "state", "active", "ralplan.json");
}

async function symlinkDir(target: string, prefix: string): Promise<string> {
	const parent = await tempDir(prefix);
	const link = path.join(parent, "link");
	await fs.symlink(target, link);
	return link;
}

function explicitWriteArgs(input: {
	worktreeRoot: string;
	stage: string;
	stageN: number;
	session: string;
	artifact: string;
	extra?: string[];
}): string[] {
	return [
		"--write",
		"--worktree-root",
		input.worktreeRoot,
		"--stage",
		input.stage,
		"--stage_n",
		String(input.stageN),
		"--session-id",
		input.session,
		"--run-id",
		input.session,
		"--artifact",
		input.artifact,
		...(input.extra ?? []),
	];
}

async function readState(root: string, sessionId: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(statePath(root, sessionId), "utf-8")) as Record<string, unknown>;
}

async function realpath(target: string): Promise<string> {
	return await fs.realpath(target);
}

describe("ralplan --worktree-root explicit target binding (#4693)", () => {
	it("keeps legacy no-target seed/write cwd-based", async () => {
		const session = "wt-legacy";
		const repo = await initRepo();
		const seed = await runNativeRalplanCommand(["--session-id", session, "--json", "legacy task"], repo);
		expect(seed.status).toBe(0);
		const write = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--session-id",
				session,
				"--run-id",
				session,
				"--artifact",
				"plan v1",
			],
			repo,
		);
		expect(write.status).toBe(0);
		expect(await pathExists(path.join(runDir(repo, session, session), "stage-01-planner.md"))).toBe(true);
		const state = await readState(repo, session);
		expect((state.repository_binding as { worktreeRoot?: string }).worktreeRoot).toBe(await realpath(repo));
	});

	it("routes seed and child-role writes from a different cwd into one explicit target tree", async () => {
		const session = "wt-two-repo";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");

		const seed = await runNativeRalplanCommand(
			["--worktree-root", target, "--session-id", session, "--json", "dispatch task"],
			dispatcher,
		);
		expect(seed.status).toBe(0);
		const seedPayload = JSON.parse(seed.stdout ?? "{}") as { repository_binding?: { worktreeRoot?: string } };
		expect(seedPayload.repository_binding?.worktreeRoot).toBe(await realpath(target));

		const planner = await runNativeRalplanCommand(
			[
				"--write",
				"--worktree-root",
				target,
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--session-id",
				session,
				"--run-id",
				session,
				"--artifact",
				"plan v1",
			],
			dispatcher,
		);
		expect(planner.status).toBe(0);
		const architect = await runNativeRalplanCommand(
			[
				"--write",
				"--worktree-root",
				target,
				"--stage",
				"architect",
				"--stage_n",
				"1",
				"--session-id",
				session,
				"--run-id",
				session,
				"--artifact",
				"review v1",
			],
			dispatcher,
		);
		expect(architect.status).toBe(0);

		// One owner state file, one run directory, one index ledger — all under the target.
		const dir = runDir(target, session, session);
		expect(await pathExists(path.join(dir, "stage-01-planner.md"))).toBe(true);
		expect(await pathExists(path.join(dir, "stage-01-architect.md"))).toBe(true);
		expect(await pathExists(path.join(dir, "index.jsonl"))).toBe(true);
		expect(await pathExists(statePath(target, session))).toBe(true);
		const indexRows = (await fs.readFile(path.join(dir, "index.jsonl"), "utf-8"))
			.split("\n")
			.filter(line => line.trim().length > 0);
		expect(indexRows.length).toBe(2);

		// The dispatcher cwd receives no ralplan state, artifact, ledger, or HUD writes.
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});

	it("resolves a relative --worktree-root and a relative --artifact from the invoking cwd", async () => {
		const session = "wt-relative";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const relativeTarget = path.relative(dispatcher, target);

		const seed = await runNativeRalplanCommand(
			["--worktree-root", relativeTarget, "--session-id", session, "--json", "relative task"],
			dispatcher,
		);
		expect(seed.status).toBe(0);
		const seedPayload = JSON.parse(seed.stdout ?? "{}") as { repository_binding?: { worktreeRoot?: string } };
		expect(seedPayload.repository_binding?.worktreeRoot).toBe(await realpath(target));

		await fs.writeFile(path.join(dispatcher, "plan.md"), "plan from dispatcher file\n");
		const write = await runNativeRalplanCommand(
			[
				"--write",
				"--worktree-root",
				relativeTarget,
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--session-id",
				session,
				"--run-id",
				session,
				"--artifact",
				"plan.md",
			],
			dispatcher,
		);
		expect(write.status).toBe(0);
		const persisted = await fs.readFile(path.join(runDir(target, session, session), "stage-01-planner.md"), "utf-8");
		expect(persisted).toBe("plan from dispatcher file\n");
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});

	it("validates a committed target with Windows-safe git argv", async () => {
		const session = "wt-windows-safe-head";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");

		const seed = await runNativeRalplanCommand(
			["--worktree-root", target, "--session-id", session, "--json", "windows-safe target task"],
			dispatcher,
		);

		expect(seed.status).toBe(0);
		expect(JSON.parse(seed.stdout ?? "{}")).toMatchObject({
			ok: true,
			repository_binding: { worktreeRoot: await realpath(target) },
		});
		expect(await pathExists(path.join(target, ".gjc"))).toBe(true);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});

	it("supports resume/restart: re-seed and later writes keep the same bound target run", async () => {
		const session = "wt-resume";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");

		const first = await runNativeRalplanCommand(
			["--worktree-root", target, "--session-id", session, "--json", "resume task"],
			dispatcher,
		);
		expect(first.status).toBe(0);
		const second = await runNativeRalplanCommand(
			["--worktree-root", target, "--session-id", session, "--json", "resume task"],
			dispatcher,
		);
		expect(second.status).toBe(0);
		const firstPayload = JSON.parse(first.stdout ?? "{}") as { run_id?: string };
		const secondPayload = JSON.parse(second.stdout ?? "{}") as { run_id?: string };
		expect(secondPayload.run_id).toBe(firstPayload.run_id);

		// A legacy writer inside the bound worktree joins the same run tree.
		const legacyWrite = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--session-id",
				session,
				"--run-id",
				session,
				"--artifact",
				"plan v1",
			],
			target,
		);
		expect(legacyWrite.status).toBe(0);
		// A later explicit write from the dispatcher lands in the same single tree.
		const explicitWrite = await runNativeRalplanCommand(
			[
				"--write",
				"--worktree-root",
				target,
				"--stage",
				"critic",
				"--stage_n",
				"1",
				"--session-id",
				session,
				"--run-id",
				session,
				"--artifact",
				"critic v1",
				"--lane-verdict",
				"OKAY",
			],
			dispatcher,
		);
		expect(explicitWrite.status).toBe(0);
		const dir = runDir(target, session, session);
		expect(await pathExists(path.join(dir, "stage-01-planner.md"))).toBe(true);
		expect(await pathExists(path.join(dir, "stage-01-critic.md"))).toBe(true);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});

	it("rejects missing, non-directory, non-git, and subdirectory targets before any mutation", async () => {
		const session = "wt-invalid";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const plainDir = await tempDir("gjc-ralplan-plain-");
		const fileTarget = path.join(dispatcher, "a-file");
		await fs.writeFile(fileTarget, "x");
		const subdir = path.join(target, "sub");
		await fs.mkdir(subdir);

		const cases: Array<{ label: string; root: string; match: RegExp }> = [
			{ label: "missing", root: path.join(target, "does-not-exist"), match: /does not exist/ },
			{ label: "non-directory", root: fileTarget, match: /not a directory/ },
			{ label: "non-git", root: plainDir, match: /not inside a git repository/ },
			{ label: "subdirectory", root: subdir, match: /must be the git worktree root/ },
		];
		for (const { label, root, match } of cases) {
			const seed = await runNativeRalplanCommand(
				["--worktree-root", root, "--session-id", session, "--json", `${label} task`],
				dispatcher,
			);
			expect(seed.status, label).toBe(2);
			expect(seed.stderr ?? "", label).toMatch(match);
			const write = await runNativeRalplanCommand(
				[
					"--write",
					"--worktree-root",
					root,
					"--stage",
					"planner",
					"--stage_n",
					"1",
					"--session-id",
					session,
					"--run-id",
					session,
					"--artifact",
					"plan",
				],
				dispatcher,
			);
			expect(write.status, `${label} write`).toBe(2);
			expect(write.stderr ?? "", `${label} write`).toMatch(match);
			// No filesystem mutation anywhere.
			expect(await pathExists(path.join(root, ".gjc")), label).toBe(false);
		}
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
		expect(await pathExists(path.join(target, ".gjc"))).toBe(false);
	});

	it("rejects a linked worktree sharing commonDir when the run is bound to a different worktreeRoot", async () => {
		const session = "wt-linked";
		const target = await initRepo("gjc-ralplan-target-");
		const linked = path.join(await tempDir("gjc-ralplan-linked-parent-"), "linked");
		await git(["worktree", "add", "--detach", linked, "HEAD"], target);

		const seed = await runNativeRalplanCommand(
			["--worktree-root", target, "--session-id", session, "--json", "linked task"],
			target,
		);
		expect(seed.status).toBe(0);

		const write = await runNativeRalplanCommand(
			[
				"--write",
				"--worktree-root",
				linked,
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--session-id",
				session,
				"--run-id",
				session,
				"--artifact",
				"plan v1",
			],
			target,
		);
		expect(write.status).toBe(2);
		expect(write.stderr ?? "").toMatch(/holds no seeded ralplan run state|must exactly equal/);
		// The linked worktree must not receive a fragmented ralplan tree.
		expect(await pathExists(path.join(linked, ".gjc"))).toBe(false);
	});

	it("resets the per-iteration lane budget from the target ledger after a revision", async () => {
		const session = "wt-budget";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		await fs.mkdir(path.join(target, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(target, ".gjc", "config.yml"), "gjc:\n  ralplan:\n    maxReviewPassesPerLane: 1\n");

		const writeStage = (stage: string, stageN: number, artifact: string, extra: string[] = []) =>
			runNativeRalplanCommand(
				[
					"--write",
					"--worktree-root",
					target,
					"--stage",
					stage,
					"--stage_n",
					String(stageN),
					"--session-id",
					session,
					"--run-id",
					session,
					"--artifact",
					artifact,
					...extra,
				],
				dispatcher,
			);

		expect(
			(
				await runNativeRalplanCommand(
					["--worktree-root", target, "--session-id", session, "budget task"],
					dispatcher,
				)
			).status,
		).toBe(0);
		expect((await writeStage("planner", 1, "plan v1")).status).toBe(0);
		expect((await writeStage("architect", 1, "architect pass 1", ["--lane-verdict", "CLEAR"])).status).toBe(0);
		// Revision in the target ledger opens consensus iteration 2 (fresh lane budget).
		expect((await writeStage("revision", 2, "revision opener")).status).toBe(0);
		// Exactly the false PLANNING-STUCK from the issue: this re-review must now pass.
		const reReview = await writeStage("architect", 2, "architect pass 1 of iteration 2", ["--lane-verdict", "CLEAR"]);
		expect(reReview.status).toBe(0);
		expect(reReview.stderr ?? "").not.toMatch(/PLANNING-STUCK/);
		const critic = await writeStage("critic", 2, "critic pass 1 of iteration 2", ["--lane-verdict", "OKAY"]);
		expect(critic.status).toBe(0);

		const dir = runDir(target, session, session);
		expect(await pathExists(path.join(dir, "stage-02-architect.md"))).toBe(true);
		expect(await pathExists(path.join(dir, "stage-02-critic.md"))).toBe(true);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});

	it("keeps duplicate-write and owner-session conflict behavior in explicit-target mode", async () => {
		const session = "wt-dedupe";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		expect(
			(
				await runNativeRalplanCommand(
					["--worktree-root", target, "--session-id", session, "dedupe task"],
					dispatcher,
				)
			).status,
		).toBe(0);

		const writePlanner = (artifact: string) =>
			runNativeRalplanCommand(
				[
					"--write",
					"--worktree-root",
					target,
					"--stage",
					"planner",
					"--stage_n",
					"1",
					"--session-id",
					session,
					"--run-id",
					session,
					"--artifact",
					artifact,
				],
				dispatcher,
			);
		expect((await writePlanner("plan v1")).status).toBe(0);
		const duplicate = await writePlanner("plan v1");
		expect(duplicate.status).toBe(0);
		expect(duplicate.stdout ?? "").toMatch(/already persisted/);
		const conflict = await writePlanner("plan v2 different content");
		expect(conflict.status).toBe(2);
		expect(conflict.stderr ?? "").toMatch(/refusing to overwrite/);

		// A foreign session cannot write into the owned run.
		const foreign = await runNativeRalplanCommand(
			[
				"--write",
				"--worktree-root",
				target,
				"--stage",
				"critic",
				"--stage_n",
				"1",
				"--session-id",
				"wt-dedupe-other",
				"--run-id",
				session,
				"--artifact",
				"foreign critic",
			],
			dispatcher,
		);
		expect(foreign.status).toBe(2);
		expect(foreign.stderr ?? "").toMatch(/is owned by session/);
	});
	it("canonicalizes absolute, nested-relative, and symlink --worktree-root onto one realpath", async () => {
		const session = "wt-path-shapes";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const nestedCwd = path.join(dispatcher, "nested", "cwd");
		await fs.mkdir(nestedCwd, { recursive: true });
		const relativeViaDotDot = path.relative(nestedCwd, target);
		const targetLink = await symlinkDir(target, "gjc-ralplan-target-link-");
		const canonical = await realpath(target);
		expect(path.isAbsolute(target)).toBe(true);
		expect(relativeViaDotDot.startsWith("..")).toBe(true);
		expect(targetLink).not.toBe(canonical);

		const viaAbsolute = await runNativeRalplanCommand(
			["--worktree-root", target, "--session-id", session, "--json", "absolute task"],
			dispatcher,
		);
		expect(viaAbsolute.status).toBe(0);
		const viaRelative = await runNativeRalplanCommand(
			["--worktree-root", relativeViaDotDot, "--session-id", session, "--json", "relative task"],
			nestedCwd,
		);
		expect(viaRelative.status).toBe(0);
		const viaSymlink = await runNativeRalplanCommand(
			["--worktree-root", targetLink, "--session-id", session, "--json", "symlink task"],
			dispatcher,
		);
		expect(viaSymlink.status).toBe(0);

		const payloads = [viaAbsolute, viaRelative, viaSymlink].map(
			result =>
				JSON.parse(result.stdout ?? "{}") as { run_id?: string; repository_binding?: { worktreeRoot?: string } },
		);
		expect(payloads[1]?.run_id).toBe(payloads[0]?.run_id);
		expect(payloads[2]?.run_id).toBe(payloads[0]?.run_id);
		for (const payload of payloads) {
			expect(payload.repository_binding?.worktreeRoot).toBe(canonical);
		}

		const writeViaSymlink = await runNativeRalplanCommand(
			explicitWriteArgs({
				worktreeRoot: targetLink,
				stage: "planner",
				stageN: 1,
				session,
				artifact: "plan v1",
			}),
			dispatcher,
		);
		expect(writeViaSymlink.status).toBe(0);
		expect(await pathExists(path.join(runDir(target, session, session), "stage-01-planner.md"))).toBe(true);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
		expect(await pathExists(path.join(path.dirname(targetLink), ".gjc"))).toBe(false);
	});

	it("keeps the bound run across a symlink writer cwd and a later dispatcher restart", async () => {
		const session = "wt-restart";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const dispatcherLink = await symlinkDir(dispatcher, "gjc-ralplan-dispatcher-link-");
		const laterDispatcher = await initRepo("gjc-ralplan-later-dispatcher-");
		const targetLink = await symlinkDir(target, "gjc-ralplan-restart-target-link-");
		const canonical = await realpath(target);

		const seed = await runNativeRalplanCommand(
			["--worktree-root", targetLink, "--session-id", session, "--json", "restart task"],
			dispatcherLink,
		);
		expect(seed.status).toBe(0);
		const seedPayload = JSON.parse(seed.stdout ?? "{}") as {
			run_id?: string;
			repository_binding?: { worktreeRoot?: string };
		};
		expect(seedPayload.repository_binding?.worktreeRoot).toBe(canonical);

		await fs.writeFile(path.join(dispatcher, "plan.md"), "plan from symlink cwd\n");
		const firstWrite = await runNativeRalplanCommand(
			explicitWriteArgs({
				worktreeRoot: path.relative(dispatcherLink, target),
				stage: "planner",
				stageN: 1,
				session,
				artifact: "plan.md",
			}),
			dispatcherLink,
		);
		expect(firstWrite.status).toBe(0);

		const restart = await runNativeRalplanCommand(
			["--worktree-root", target, "--session-id", session, "--json", "restart task"],
			laterDispatcher,
		);
		expect(restart.status).toBe(0);
		const restartPayload = JSON.parse(restart.stdout ?? "{}") as {
			run_id?: string;
			repository_binding?: { worktreeRoot?: string };
		};
		expect(restartPayload.run_id).toBe(seedPayload.run_id);
		expect(restartPayload.repository_binding?.worktreeRoot).toBe(canonical);

		const laterWrite = await runNativeRalplanCommand(
			explicitWriteArgs({
				worktreeRoot: target,
				stage: "architect",
				stageN: 1,
				session,
				artifact: "review v1",
			}),
			laterDispatcher,
		);
		expect(laterWrite.status).toBe(0);

		const dir = runDir(target, session, session);
		expect(await fs.readFile(path.join(dir, "stage-01-planner.md"), "utf-8")).toBe("plan from symlink cwd\n");
		expect(await pathExists(path.join(dir, "stage-01-architect.md"))).toBe(true);
		expect(await pathExists(hudPath(target, session))).toBe(true);
		expect(await pathExists(activeEntryPath(target, session))).toBe(true);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
		expect(await pathExists(path.join(laterDispatcher, ".gjc"))).toBe(false);
		expect(await pathExists(path.join(path.dirname(dispatcherLink), ".gjc"))).toBe(false);
	});

	it("rejects blank --worktree-root and records stuck markers only on the bound target", async () => {
		const session = "wt-blank-stuck";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		await fs.mkdir(path.join(target, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(target, ".gjc", "config.yml"), "gjc:\n  ralplan:\n    maxReviewPassesPerLane: 1\n");

		const blank = await runNativeRalplanCommand(
			["--worktree-root", "   ", "--session-id", session, "--json", "blank task"],
			dispatcher,
		);
		expect(blank.status).toBe(2);
		expect(blank.stderr ?? "").toMatch(/requires a non-empty path/);
		const trailing = await runNativeRalplanCommand(
			["--session-id", session, "--json", "trailing task", "--worktree-root"],
			dispatcher,
		);
		expect(trailing.status).toBe(2);
		expect(trailing.stderr ?? "").toMatch(/requires a non-empty path/);
		const trailingWrite = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--session-id",
				session,
				"--run-id",
				session,
				"--artifact",
				"plan",
				"--worktree-root",
			],
			dispatcher,
		);
		expect(trailingWrite.status).toBe(2);
		expect(trailingWrite.stderr ?? "").toMatch(/requires a non-empty path/);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
		expect(await pathExists(path.join(target, ".gjc", `_session-${session}`))).toBe(false);

		expect(
			(await runNativeRalplanCommand(["--worktree-root", target, "--session-id", session, "stuck task"], dispatcher))
				.status,
		).toBe(0);
		expect(
			(
				await runNativeRalplanCommand(
					explicitWriteArgs({
						worktreeRoot: target,
						stage: "planner",
						stageN: 1,
						session,
						artifact: "plan v1",
					}),
					dispatcher,
				)
			).status,
		).toBe(0);
		expect(
			(
				await runNativeRalplanCommand(
					explicitWriteArgs({
						worktreeRoot: target,
						stage: "architect",
						stageN: 1,
						session,
						artifact: "architect pass 1",
						extra: ["--lane-verdict", "CLEAR"],
					}),
					dispatcher,
				)
			).status,
		).toBe(0);
		const stuck = await runNativeRalplanCommand(
			explicitWriteArgs({
				worktreeRoot: target,
				stage: "architect",
				stageN: 2,
				session,
				artifact: "architect pass 2 same iteration",
				extra: ["--lane-verdict", "CLEAR"],
			}),
			dispatcher,
		);
		expect(stuck.status).toBe(3);
		expect(stuck.stderr ?? "").toMatch(/PLANNING-STUCK/);
		const index = await fs.readFile(path.join(runDir(target, session, session), "index.jsonl"), "utf-8");
		expect(index).toMatch(/planning_stuck/);
		const state = await readState(target, session);
		expect(state.planning_stuck).toEqual(expect.objectContaining({ marker: "PLANNING-STUCK" }));
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});
	it("rejects a fake .git directory that is not a valid worktree before mutation", async () => {
		const session = "wt-fake-git";
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const fake = await tempDir("gjc-ralplan-fake-git-");
		await fs.mkdir(path.join(fake, ".git"));
		const seed = await runNativeRalplanCommand(
			["--worktree-root", fake, "--session-id", session, "--json", "fake git task"],
			dispatcher,
		);
		expect(seed.status).toBe(2);
		expect(seed.stderr ?? "").toMatch(/not a valid git worktree|not inside a git repository/);
		expect(await pathExists(path.join(fake, ".gjc"))).toBe(false);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});

	it("rejects duplicate --worktree-root flags before mutation", async () => {
		const session = "wt-dup-flag";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const seed = await runNativeRalplanCommand(
			["--worktree-root", target, "--session-id", session, "--json", "dup task", "--worktree-root"],
			dispatcher,
		);
		expect(seed.status).toBe(2);
		expect(seed.stderr ?? "").toMatch(/at most once|requires a non-empty path/);
		const write = await runNativeRalplanCommand(
			[
				"--write",
				"--worktree-root",
				target,
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--session-id",
				session,
				"--run-id",
				session,
				"--artifact",
				"plan",
				"--worktree-root",
			],
			dispatcher,
		);
		expect(write.status).toBe(2);
		expect(write.stderr ?? "").toMatch(/at most once|requires a non-empty path/);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
		expect(await pathExists(path.join(target, ".gjc"))).toBe(false);
	});

	it("rejects an explicit-target --artifact file that escapes the invoking cwd", async () => {
		const session = "wt-artifact-escape";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const outsider = await tempDir("gjc-ralplan-outside-artifact-");
		const secret = path.join(outsider, "secret.md");
		await fs.writeFile(secret, "should not be ingested\n");
		expect(
			(
				await runNativeRalplanCommand(
					["--worktree-root", target, "--session-id", session, "escape task"],
					dispatcher,
				)
			).status,
		).toBe(0);
		const write = await runNativeRalplanCommand(
			explicitWriteArgs({
				worktreeRoot: target,
				stage: "planner",
				stageN: 1,
				session,
				artifact: secret,
			}),
			dispatcher,
		);
		expect(write.status).toBe(2);
		expect(write.stderr ?? "").toMatch(/escapes the invoking cwd/);
		expect(await pathExists(path.join(runDir(target, session, session), "stage-01-planner.md"))).toBe(false);
	});

	it("renders --worktree-root on the bundled role persistence command", () => {
		expect(ralplanPersistenceTemplate).toMatch(
			/gjc ralplan --write --worktree-root <repository_binding\.worktreeRoot>/,
		);
	});

	it("public CLI validates --worktree-root before migrating dispatcher settings", async () => {
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		await fs.mkdir(path.join(dispatcher, ".gjc"), { recursive: true });
		const settingsPath = path.join(dispatcher, ".gjc", "settings.json");
		await fs.writeFile(settingsPath, JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		const missing = path.join(dispatcher, "does-not-exist");
		const probe = path.join(import.meta.dir, "../fixtures/ralplan-cli-worktree-root-probe.ts");
		const proc = Bun.spawn(
			[process.execPath, probe, "--worktree-root", missing, "--session-id", "cli-nomut", "--json", "task"],
			{
				cwd: dispatcher,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, GJC_SESSION_ID: undefined },
			},
		);
		const status = await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		expect(status).toBe(2);
		expect(stderr).toMatch(/does not exist/);
		expect(await pathExists(settingsPath)).toBe(true);
		expect(await pathExists(path.join(dispatcher, ".gjc", "config.yml"))).toBe(false);
		const result = await runRalplanCliCommand(
			["--worktree-root", missing, "--session-id", "cli-nomut", "--json", "task"],
			dispatcher,
		);
		expect(result.status).toBe(2);
		expect(result.stderr ?? "").toMatch(/does not exist/);
		expect(await pathExists(path.join(dispatcher, ".gjc", "config.yml"))).toBe(false);
	});
	it("rejects a forged detached HEAD that is not a git commit object", async () => {
		const session = "wt-forged-detached";
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const fake = await tempDir("gjc-ralplan-forged-detached-");
		await fs.mkdir(path.join(fake, ".git"));
		await fs.writeFile(path.join(fake, ".git", "HEAD"), "not-a-commit\n");
		const seed = await runNativeRalplanCommand(
			["--worktree-root", fake, "--session-id", session, "--json", "forged detached"],
			dispatcher,
		);
		expect(seed.status).toBe(2);
		expect(seed.stderr ?? "").toMatch(/not a valid git worktree|not inside a git repository/);
		expect(await pathExists(path.join(fake, ".gjc"))).toBe(false);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});

	it.each(["blob", "tree"] as const)("rejects a %s object in HEAD before seed or write mutation", async kind => {
		const session = `wt-noncommit-${kind}`;
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const target = await initRepo(`gjc-ralplan-${kind}-head-`);
		const objectId =
			kind === "blob"
				? await gitText(["hash-object", "-w", "--stdin"], target, "not a commit")
				: await gitText(["write-tree"], target);
		await fs.writeFile(path.join(target, ".git", "HEAD"), `${objectId}\n`);

		const seed = await runNativeRalplanCommand(
			["--worktree-root", target, "--session-id", session, "--json", `${kind} head`],
			dispatcher,
		);
		expect(seed.status).toBe(2);
		expect(seed.stderr ?? "").toMatch(/not a commit worktree/);
		expect(await pathExists(path.join(target, ".gjc"))).toBe(false);

		const write = await runNativeRalplanCommand(
			explicitWriteArgs({
				worktreeRoot: target,
				stage: "planner",
				stageN: 1,
				session,
				artifact: "must not write",
			}),
			dispatcher,
		);
		expect(write.status).toBe(2);
		expect(write.stderr ?? "").toMatch(/not a commit worktree/);
		expect(await pathExists(path.join(target, ".gjc"))).toBe(false);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});

	it("accepts a valid SHA-256 commit worktree", async () => {
		const session = "wt-sha256";
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const target = await tempDir("gjc-ralplan-sha256-");
		await git(["init", "--object-format=sha256"], target);
		await git(
			["-c", "user.email=test@gjc.local", "-c", "user.name=gjc-test", "commit", "--allow-empty", "-m", "init"],
			target,
		);

		const seed = await runNativeRalplanCommand(
			["--worktree-root", target, "--session-id", session, "--json", "sha256 head"],
			dispatcher,
		);
		expect(seed.status).toBe(0);
		expect(await pathExists(path.join(target, ".gjc"))).toBe(true);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});

	it("rejects a forged ref HEAD that does not resolve in the object database", async () => {
		const session = "wt-forged-ref";
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const fake = await tempDir("gjc-ralplan-forged-ref-");
		await fs.mkdir(path.join(fake, ".git", "refs", "heads"), { recursive: true });
		await fs.writeFile(path.join(fake, ".git", "HEAD"), "ref: refs/heads/main\n");
		await fs.writeFile(
			path.join(fake, ".git", "refs", "heads", "main"),
			"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n",
		);
		const seed = await runNativeRalplanCommand(
			["--worktree-root", fake, "--session-id", session, "--json", "forged ref"],
			dispatcher,
		);
		expect(seed.status).toBe(2);
		expect(seed.stderr ?? "").toMatch(/not a valid git worktree|not inside a git repository/);
		expect(await pathExists(path.join(fake, ".gjc"))).toBe(false);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});

	it("rejects a target whose .gjc is a symlink outside the worktree", async () => {
		const session = "wt-gjc-symlink";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const outside = await tempDir("gjc-ralplan-gjc-outside-");
		await fs.symlink(outside, path.join(target, ".gjc"));
		const seed = await runNativeRalplanCommand(
			["--worktree-root", target, "--session-id", session, "--json", "symlink gjc"],
			dispatcher,
		);
		expect(seed.status).toBe(2);
		expect(seed.stderr ?? "").toMatch(/symlinked \.gjc|escapes the target worktree/);
		expect(await pathExists(path.join(outside, `_session-${session}`))).toBe(false);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});

	it("rejects an in-cwd artifact symlink so a swapped path cannot be followed", async () => {
		const session = "wt-artifact-nofollow";
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const outsider = await tempDir("gjc-ralplan-outside-swap-");
		await fs.writeFile(path.join(outsider, "secret.md"), "external bytes\n");
		await fs.symlink(path.join(outsider, "secret.md"), path.join(dispatcher, "plan.md"));
		expect(
			(
				await runNativeRalplanCommand(
					["--worktree-root", target, "--session-id", session, "nofollow task"],
					dispatcher,
				)
			).status,
		).toBe(0);
		const write = await runNativeRalplanCommand(
			explicitWriteArgs({
				worktreeRoot: target,
				stage: "planner",
				stageN: 1,
				session,
				artifact: "plan.md",
			}),
			dispatcher,
		);
		expect(write.status).toBe(2);
		expect(write.stderr ?? "").toMatch(/escapes the invoking cwd|failed to read --artifact/);
		expect(await pathExists(path.join(runDir(target, session, session), "stage-01-planner.md"))).toBe(false);
	});
	it("public CLI refuses a symlinked target .gjc before settings migration", async () => {
		const target = await initRepo("gjc-ralplan-target-");
		const dispatcher = await initRepo("gjc-ralplan-dispatcher-");
		const outside = await tempDir("gjc-ralplan-gjc-outside-cli-");
		await fs.writeFile(path.join(outside, "settings.json"), JSON.stringify({ "gjc.ralplan.maxIterations": 7 }));
		await fs.symlink(outside, path.join(target, ".gjc"));
		const probe = path.join(import.meta.dir, "../fixtures/ralplan-cli-worktree-root-probe.ts");
		const proc = Bun.spawn(
			[process.execPath, probe, "--worktree-root", target, "--session-id", "cli-gjc-symlink", "--json", "task"],
			{
				cwd: dispatcher,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			},
		);
		const status = await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		expect(status).toBe(2);
		expect(stderr).toMatch(/symlinked \.gjc|escapes the target worktree/);
		expect(await pathExists(path.join(outside, "config.yml"))).toBe(false);
		expect(await pathExists(path.join(dispatcher, ".gjc"))).toBe(false);
	});
});
