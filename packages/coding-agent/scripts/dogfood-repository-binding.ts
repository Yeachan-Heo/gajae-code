/**
 * Product-surface dogfood for #2901 repository binding.
 *
 * Creates two sibling git repos, runs real `gjc ultragoal` / `gjc ralplan`
 * CLI entrypoints from source, and prints fail-closed mismatch evidence.
 *
 * Usage (from monorepo root):
 *   bun packages/coding-agent/scripts/dogfood-repository-binding.ts
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertCwdMatchesRepositoryBinding,
	assertPathUnderRepositoryBinding,
	parseRepositoryBinding,
	resolveTaskRepositoryBinding,
} from "../src/gjc-runtime/repository-binding";
import { readUltragoalPlan, startNextUltragoalGoal } from "../src/gjc-runtime/ultragoal-runtime";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repoRoot, "packages/coding-agent/src/cli.ts");

async function runGit(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

async function initRepo(root: string): Promise<void> {
	await fsp.mkdir(root, { recursive: true });
	await runGit(root, ["init"]);
	await runGit(root, ["config", "user.email", "dogfood@example.com"]);
	await runGit(root, ["config", "user.name", "Dogfood"]);
	await fsp.writeFile(path.join(root, "README.md"), `repo ${path.basename(root)}\n`);
	await runGit(root, ["add", "README.md"]);
	await runGit(root, ["commit", "-m", `init ${path.basename(root)}`]);
}

async function runCli(
	cwd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", cli, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, stdout, stderr };
}

async function main(): Promise<void> {
	const dogfoodRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-dogfood-2901-"));
	const left = path.join(dogfoodRoot, "gajae-code");
	const right = path.join(dogfoodRoot, "oh-my-openagent-senpi");
	await initRepo(left);
	await initRepo(right);

	const sessionId = `dogfood-2901-${process.pid}`;
	const env = { ...process.env, GJC_SESSION_ID: sessionId };

	console.log("# Dogfood: repository binding (#2901)");
	console.log(`root=${dogfoodRoot}`);
	console.log(`left=${left}`);
	console.log(`right=${right}`);
	console.log(`session=${sessionId}`);
	console.log(`cli=${cli}`);
	console.log(`bun=${Bun.version}`);
	console.log(
		`commit=${Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--short", "HEAD"]).stdout.toString().trim()}`,
	);
	console.log();

	// 1) Product CLI: create goals stamps binding
	const create = await runCli(
		left,
		[
			"ultragoal",
			"create-goals",
			"--brief",
			"@goal dogfood binding\nProve repository binding stamps and fail-closed sibling mismatch.",
			"--json",
		],
		env,
	);
	console.log("## 1) gjc ultragoal create-goals (LEFT)");
	console.log(`exit=${create.code}`);
	console.log(create.stdout.trim() || create.stderr.trim());
	if (create.code !== 0) process.exit(1);

	const plan = await readUltragoalPlan(left, sessionId);
	if (!plan?.repositoryBinding) {
		console.error("FAIL: plan missing repositoryBinding");
		process.exit(1);
	}
	console.log();
	console.log("## 2) goals.json repositoryBinding");
	console.log(JSON.stringify(plan.repositoryBinding, null, 2));

	// 2) Matching cwd starts goal
	console.log();
	console.log("## 3) startNextUltragoalGoal on LEFT (match)");
	const started = await startNextUltragoalGoal({ cwd: left, sessionId });
	console.log(`ok goal=${started.goal?.id} status=${started.goal?.status}`);

	// 3) Sibling mismatch fails closed
	console.log();
	console.log("## 4) assertCwdMatchesRepositoryBinding on RIGHT (sibling)");
	try {
		await assertCwdMatchesRepositoryBinding(right, plan.repositoryBinding);
		console.error("FAIL: expected identity_mismatch");
		process.exit(1);
	} catch (error) {
		console.log(`fail_closed: ${error instanceof Error ? error.message : String(error)}`);
	}

	// 4) Path escape fails closed
	console.log();
	console.log("## 5) assertPathUnderRepositoryBinding sibling absolute path");
	try {
		assertPathUnderRepositoryBinding(plan.repositoryBinding, path.join(right, "README.md"));
		console.error("FAIL: expected path_outside_root");
		process.exit(1);
	} catch (error) {
		console.log(`fail_closed: ${error instanceof Error ? error.message : String(error)}`);
	}

	// 5) Task binding stamp + sibling fail-closed (pre-discovery authority)
	console.log();
	console.log("## 6) task binding stamp (omit declaration) + sibling reject");
	const stamped = await resolveTaskRepositoryBinding(left, undefined);
	console.log(`stamped_worktreeRoot=${stamped.worktreeRoot}`);
	await assertCwdMatchesRepositoryBinding(left, stamped);
	console.log("task_stamp_ok on LEFT");
	const taskBinding = parseRepositoryBinding(plan.repositoryBinding);
	try {
		await resolveTaskRepositoryBinding(right, taskBinding);
		console.error("FAIL: task binding should reject RIGHT");
		process.exit(1);
	} catch (error) {
		console.log(`task_binding_fail_closed on RIGHT: ${error instanceof Error ? error.message : String(error)}`);
	}

	// 6) Ralplan seed stamps binding via product CLI
	console.log();
	console.log("## 7) gjc ralplan seed (LEFT)");
	const ralplan = await runCli(left, ["ralplan", "--json", "dogfood multi-repo binding"], env);
	console.log(`exit=${ralplan.code}`);
	console.log(ralplan.stdout.trim() || ralplan.stderr.trim());
	if (ralplan.code !== 0) process.exit(1);
	const statePath = path.join(left, ".gjc", `_session-${sessionId}`, "state", "ralplan-state.json");
	const state = JSON.parse(await fsp.readFile(statePath, "utf8")) as {
		repository_binding?: unknown;
		run_id?: string;
	};
	console.log();
	console.log("## 8) ralplan-state.json repository_binding");
	console.log(JSON.stringify({ run_id: state.run_id, repository_binding: state.repository_binding }, null, 2));
	if (!state.repository_binding) {
		console.error("FAIL: ralplan state missing repository_binding");
		process.exit(1);
	}

	// 7) Ralplan stage write on LEFT succeeds and echoes repository_binding
	console.log();
	console.log("## 9) gjc ralplan --write planner on LEFT (match)");
	const notePath = path.join(left, "dogfood-planner.md");
	await fsp.writeFile(notePath, "# dogfood planner\n");
	const writeLeft = await runCli(
		left,
		["ralplan", "--write", "--stage", "planner", "--stage_n", "1", "--artifact", notePath, "--json"],
		env,
	);
	console.log(`exit=${writeLeft.code}`);
	console.log(writeLeft.stdout.trim() || writeLeft.stderr.trim());
	if (writeLeft.code !== 0) process.exit(1);
	const writePayload = JSON.parse(writeLeft.stdout) as { repository_binding?: { worktreeRoot?: string } };
	if (!writePayload.repository_binding?.worktreeRoot) {
		console.error("FAIL: write receipt missing repository_binding");
		process.exit(1);
	}

	// 8) Copy seed authority into RIGHT session layout → stage write fails closed
	console.log();
	console.log("## 10) ralplan --write on RIGHT with LEFT binding (fail-closed)");
	const rightStateDir = path.join(right, ".gjc", `_session-${sessionId}`, "state");
	await fsp.mkdir(rightStateDir, { recursive: true });
	await fsp.copyFile(statePath, path.join(rightStateDir, "ralplan-state.json"));
	const writeRight = await runCli(
		right,
		["ralplan", "--write", "--stage", "architect", "--stage_n", "1", "--artifact", "# arch\n", "--json"],
		env,
	);
	console.log(`exit=${writeRight.code}`);
	console.log((writeRight.stderr || writeRight.stdout).trim());
	if (writeRight.code === 0) {
		console.error("FAIL: expected sibling write to fail closed");
		process.exit(1);
	}
	console.log("fail_closed: ralplan write on sibling rejected");

	console.log();
	console.log("DOGFOOD_OK");
}

await main();
