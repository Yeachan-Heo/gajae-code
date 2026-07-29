/**
 * Product-surface dogfood for #2902 ralplan typed review conflicts.
 *
 * Uses the **compiled** `packages/coding-agent/dist/gjc` binary (not source
 * `cli.ts`) so evidence matches the owner exact-head compiled-binary gate:
 *   1) open conflicts fail closed (exit 2, Join blocked)
 *   2) complete disposition document is accepted and persisted
 *   3) stored artifact is dispositioned under ralplan.review_conflicts.v1
 *   4) spoofed receipts fail closed against the run index
 *
 * Prerequisites (from monorepo root, same HEAD):
 *   bun run build
 *   bun packages/coding-agent/scripts/dogfood-ralplan-review-conflicts.ts
 *
 * Optional: GJC_BINARY=/path/to/gjc overrides the default dist path.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultBinary = path.join(repoRoot, "packages/coding-agent/dist/gjc");

async function resolveCompiledBinary(): Promise<string> {
	const binary = process.env.GJC_BINARY?.trim() || defaultBinary;
	try {
		const st = await fsp.stat(binary);
		if (!st.isFile()) throw new Error(`not a file: ${binary}`);
		// Ensure executable bit is present for direct spawn.
		await fsp.access(binary, fsp.constants.X_OK).catch(async () => {
			await fsp.chmod(binary, 0o755);
		});
	} catch (error) {
		throw new Error(
			`Compiled binary missing or not executable: ${binary}. Run \`bun run build\` on this exact HEAD first. (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	return binary;
}

async function runGjc(
	binary: string,
	cwd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([binary, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, stdout, stderr };
}

async function main(): Promise<void> {
	const binary = await resolveCompiledBinary();
	const dogfoodRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-dogfood-2902-"));
	const sessionId = `dogfood-2902-${process.pid}`;
	const env = { ...process.env, GJC_SESSION_ID: sessionId };
	const full = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "HEAD"]).stdout.toString().trim();
	const short = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--short=8", "HEAD"]).stdout.toString().trim();
	const binaryStat = await fsp.stat(binary);

	console.log("# Dogfood: ralplan review conflicts (#2902) — compiled binary");
	console.log(`root=${dogfoodRoot}`);
	console.log(`session=${sessionId}`);
	console.log(`binary=${binary}`);
	console.log(`binary_size=${binaryStat.size}`);
	console.log(`binary_mtime=${binaryStat.mtime.toISOString()}`);
	console.log(`commit=${short}`);
	console.log(`commit_full=${full}`);
	console.log(`bun=${Bun.version}`);
	console.log();

	// Seed ralplan run state so --write has an active run.
	console.log("## 1) compiled gjc ralplan seed");
	const seed = await runGjc(binary, dogfoodRoot, ["ralplan", "--deliberate", "--json", "dogfood #2902"], env);
	console.log(`exit=${seed.code}`);
	console.log((seed.stdout || seed.stderr).trim());
	if (seed.code !== 0) process.exit(1);

	// Persist same-pass Architect/Critic artifacts so disposition receipts resolve.
	console.log();
	console.log("## 2) seed architect + critic stage artifacts (same-pass stage_n=1)");
	const architect = await runGjc(
		binary,
		dogfoodRoot,
		["ralplan", "--write", "--stage", "architect", "--stage_n", "1", "--artifact", "# architect", "--json"],
		env,
	);
	console.log(`architect exit=${architect.code}`);
	if (architect.code !== 0) {
		console.error(architect.stderr || architect.stdout);
		process.exit(1);
	}
	const critic = await runGjc(
		binary,
		dogfoodRoot,
		["ralplan", "--write", "--stage", "critic", "--stage_n", "1", "--artifact", "# critic", "--json"],
		env,
	);
	console.log(`critic exit=${critic.code}`);
	if (critic.code !== 0) {
		console.error(critic.stderr || critic.stdout);
		process.exit(1);
	}
	const archReceipt = JSON.parse(architect.stdout) as { path: string; sha256: string };
	const critReceipt = JSON.parse(critic.stdout) as { path: string; sha256: string };
	console.log(`architect path=${archReceipt.path}`);
	console.log(`critic path=${critReceipt.path}`);

	const findings = [
		{
			findingId: "arch-1",
			targetId: "contract.field",
			action: "remove",
			severity: "block",
			evidence: "redundant with session identity",
			sourceRole: "architect",
			sourceReceipt: {
				stage: "architect",
				stageN: 1,
				path: archReceipt.path,
				sha256: archReceipt.sha256,
			},
		},
		{
			findingId: "crit-1",
			targetId: "contract.field",
			action: "add",
			severity: "watch",
			evidence: "needed for multi-repo binding",
			sourceRole: "critic",
			sourceReceipt: {
				stage: "critic",
				stageN: 1,
				path: critReceipt.path,
				sha256: critReceipt.sha256,
			},
		},
	];

	// 3) Open disposition must fail closed.
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
	console.log("## 3) disposition stage with open conflicts (expect fail-closed)");
	const open = await runGjc(
		binary,
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

	// 4) Spoofed receipt must fail closed.
	const spoofPath = path.join(dogfoodRoot, "spoof-disposition.json");
	await fsp.writeFile(
		spoofPath,
		JSON.stringify({
			schema: "ralplan.review_conflicts.v1",
			plannerStageN: 1,
			findings: [
				{
					...findings[0],
					sourceReceipt: {
						stage: "architect",
						stageN: 1,
						path: "/tmp/spoofed.md",
						sha256: "deadbeef",
					},
				},
				findings[1],
			],
			dispositions: [
				{
					conflictId: "conflict:contract.field:arch-1:crit-1",
					choice: "accept_architect",
					rationale: "spoof should not land",
					decisionOwner: "ralplan-leader",
					affectedSections: ["## Contracts"],
				},
			],
		}),
	);
	console.log();
	console.log("## 4) disposition with spoofed receipt (expect fail-closed)");
	const spoof = await runGjc(
		binary,
		dogfoodRoot,
		["ralplan", "--write", "--stage", "disposition", "--stage_n", "1", "--artifact", spoofPath],
		env,
	);
	console.log(`exit=${spoof.code}`);
	console.log((spoof.stderr || spoof.stdout).trim());
	if (spoof.code !== 2 || !`${spoof.stderr}${spoof.stdout}`.includes("does not match indexed")) {
		console.error("FAIL: expected exit=2 for spoofed receipt");
		process.exit(1);
	}
	console.log("spoof_rejected: ok");

	// 5) Complete disposition must accept and persist.
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
	console.log("## 5) disposition stage with complete dispositions (expect accept)");
	const closed = await runGjc(
		binary,
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
	console.log("## 6) persisted disposition artifact");
	console.log(`path=${payload.path}`);
	console.log(body.slice(0, 1200));
	if (!body.includes("ralplan.review_conflicts.v1") || !body.includes("dispositioned")) {
		console.error("FAIL: artifact missing schema or dispositioned status");
		process.exit(1);
	}

	console.log();
	console.log("DOGFOOD_OK");
	console.log(`DOGFOOD_BINARY=${binary}`);
	console.log(`DOGFOOD_HEAD=${full}`);
}

await main();
