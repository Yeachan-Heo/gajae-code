/**
 * Product-surface dogfood for #2902 ralplan typed review conflicts.
 *
 * Uses the real `gjc ralplan --write --stage disposition` CLI entrypoint
 * (via source cli.ts) to prove:
 *   1) open conflicts fail closed (exit 2, Join blocked)
 *   2) complete disposition document is accepted and persisted
 *   3) stored artifact is dispositioned under ralplan.review_conflicts.v1
 *
 * Usage (from monorepo root):
 *   bun packages/coding-agent/scripts/dogfood-ralplan-review-conflicts.ts
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repoRoot, "packages/coding-agent/src/cli.ts");

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
	const dogfoodRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-dogfood-2902-"));
	const sessionId = `dogfood-2902-${process.pid}`;
	const env = { ...process.env, GJC_SESSION_ID: sessionId };
	const short = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--short", "HEAD"]).stdout.toString().trim();

	console.log("# Dogfood: ralplan review conflicts (#2902)");
	console.log(`root=${dogfoodRoot}`);
	console.log(`session=${sessionId}`);
	console.log(`cli=${cli}`);
	console.log(`bun=${Bun.version}`);
	console.log(`commit=${short}`);
	console.log();

	const findings = [
		{
			findingId: "arch-1",
			targetId: "contract.field",
			action: "remove",
			severity: "block",
			evidence: "redundant with session identity",
			sourceRole: "architect",
			sourceReceipt: { stage: "architect", stageN: 1, path: "/tmp/a.md", sha256: "a" },
		},
		{
			findingId: "crit-1",
			targetId: "contract.field",
			action: "add",
			severity: "watch",
			evidence: "needed for multi-repo binding",
			sourceRole: "critic",
			sourceReceipt: { stage: "critic", stageN: 1, path: "/tmp/c.md", sha256: "c" },
		},
	];

	// Seed ralplan run state so --write has an active run.
	console.log("## 1) gjc ralplan seed");
	const seed = await runCli(dogfoodRoot, ["ralplan", "--deliberate", "--json", "dogfood #2902"], env);
	console.log(`exit=${seed.code}`);
	console.log((seed.stdout || seed.stderr).trim());
	if (seed.code !== 0) process.exit(1);

	// 2) Open disposition must fail closed.
	const openPath = path.join(dogfoodRoot, "open-disposition.json");
	await fsp.writeFile(
		openPath,
		JSON.stringify({
			schema: "ralplan.review_conflicts.v1",
			plannerStageN: 1,
			findings,
			dispositions: [],
		}),
	);
	console.log();
	console.log("## 2) disposition stage with open conflicts (expect fail-closed)");
	const open = await runCli(
		dogfoodRoot,
		["ralplan", "--write", "--stage", "disposition", "--stage_n", "1", "--artifact", openPath],
		env,
	);
	console.log(`exit=${open.code}`);
	console.log((open.stderr || open.stdout).trim());
	if (open.code !== 2 || !`${open.stderr}${open.stdout}`.includes("Join blocked")) {
		console.error("FAIL: expected exit=2 and Join blocked for open conflicts");
		process.exit(1);
	}
	console.log("fail_closed: ok");

	// 3) Complete disposition must accept and persist.
	const closedPath = path.join(dogfoodRoot, "closed-disposition.json");
	await fsp.writeFile(
		closedPath,
		JSON.stringify({
			schema: "ralplan.review_conflicts.v1",
			plannerStageN: 1,
			findings,
			dispositions: [
				{
					conflictId: "conflict:contract.field:arch-1:crit-1",
					choice: "accept_architect",
					rationale: "Field duplicates existing session identity.",
					decisionOwner: "ralplan-leader",
					affectedSections: ["## Contracts"],
				},
			],
		}),
	);
	console.log();
	console.log("## 3) disposition stage with complete dispositions (expect accept)");
	const closed = await runCli(
		dogfoodRoot,
		["ralplan", "--write", "--stage", "disposition", "--stage_n", "1", "--artifact", closedPath, "--json"],
		env,
	);
	console.log(`exit=${closed.code}`);
	console.log(closed.stdout.trim() || closed.stderr.trim());
	if (closed.code !== 0) {
		console.error("FAIL: expected disposition write success");
		process.exit(1);
	}
	const payload = JSON.parse(closed.stdout) as { path?: string; stage?: string };
	if (payload.stage !== "disposition" || !payload.path) {
		console.error("FAIL: unexpected write payload", payload);
		process.exit(1);
	}
	const body = await fsp.readFile(payload.path, "utf-8");
	console.log();
	console.log("## 4) persisted disposition artifact");
	console.log(`path=${payload.path}`);
	console.log(body.slice(0, 1200));
	if (!body.includes("ralplan.review_conflicts.v1") || !body.includes("dispositioned")) {
		console.error("FAIL: artifact missing schema or dispositioned status");
		process.exit(1);
	}

	console.log();
	console.log("DOGFOOD_OK");
}

await main();
