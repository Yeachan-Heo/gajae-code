import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describeTasks, expandWithDependents, isDarwinArm64TabWorkerSmokePath, isWindowsSessionPathRegressionPath, loadBuildInventory, needsDarwinArm64TabWorkerSmoke, needsWindowsSessionPathRegression, normalizeChangedPaths, packageScriptCommand, planFullTasks, planTargetedTasks, planTasks, requiresCargoWorkspaceEmergency, resolvePackageCwd, runCommand, validateAffectedAggregate, type AffectedAggregateResults, type CargoInventoryUnit, type WorkspacePackage } from "./ci-dev-affected";

// Matrix planning validates live workspace and Cargo manifests in subprocesses.
// Hosted runners can need more than Bun's 5s default during their first cold scan.
setDefaultTimeout(30_000);

const packages: WorkspacePackage[] = [
	{
		name: "@gajae-code/example",
		dir: "packages/example",
		manifest: { name: "@gajae-code/example", scripts: { check: "true", test: "true" } },
	},
];

function planForPaths(paths: readonly string[]) {
	return planTasks(paths, packages);
}

describe("planTasks command shape (issue #622)", () => {
	test("no scheduled command uses the false-green standalone `bun --cwd <dir>` form", () => {
		const tasks = planForPaths(["packages/example/src/index.ts"]);
		expect(tasks.length).toBeGreaterThan(0);
		for (const task of tasks) {
			expect(task.command).not.toContain("--cwd");
			expect(task.command.some(arg => arg.startsWith("--cwd"))).toBe(false);
		}
	});


	test("package check/test tasks run `bun run <script>` in the package cwd", () => {
		const tasks = planForPaths(["packages/example/src/index.ts"]);
		const check = tasks.find(task => task.key === "check:@gajae-code/example");
		const runTest = tasks.find(task => task.key === "test:@gajae-code/example");
		expect(check).toBeDefined();
		expect(runTest).toBeDefined();
		expect(check?.command).toEqual(["bun", "run", "check"]);
		expect(runTest?.command).toEqual(["bun", "run", "test"]);
		expect(check?.cwd).toBe(resolvePackageCwd("packages/example"));
		expect(runTest?.cwd).toBe(resolvePackageCwd("packages/example"));
	});

});

describe("dev-ci canonical-plan workflow contract", () => {
	test("pins independent no-shard and multi-shard detached-document byte oracles", () => {
		const noShardManifest = "{\"schemaVersion\":1,\"subject\":\"ci-dev-affected-evidence\",\"sourceSha\":\"0123456789abcdef0123456789abcdef01234567\",\"planDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"planMode\":\"pr\",\"replayScope\":{\"repository\":\"owner/repo\",\"workflow\":\"Dev CI\",\"runId\":\"42\"},\"aggregateResults\":{\"plan\":\"success\",\"native\":\"skipped\",\"shards\":\"skipped\",\"windowsDoctor\":\"skipped\",\"windowsDoctorRequired\":\"false\",\"telegramGuard\":\"skipped\",\"telegramGuardRequired\":\"false\",\"telegramWindows\":\"skipped\",\"telegramWindowsRequired\":\"false\",\"hasNative\":\"false\",\"hasTasks\":\"false\",\"darwinArm64TabWorkerSmoke\":\"skipped\",\"darwinArm64TabWorkerSmokeRequired\":\"false\"},\"taskIdentities\":[],\"childEvidence\":[{\"name\":\".ci-dev-affected-plan.json\",\"sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}]}\n";
		const multiShardManifest = "{\"schemaVersion\":1,\"subject\":\"ci-dev-affected-evidence\",\"sourceSha\":\"0123456789abcdef0123456789abcdef01234567\",\"planDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"planMode\":\"push\",\"replayScope\":{\"repository\":\"owner/repo\",\"workflow\":\"Dev CI\",\"runId\":\"42\"},\"aggregateResults\":{\"plan\":\"success\",\"native\":\"success\",\"shards\":\"success\",\"windowsDoctor\":\"success\",\"windowsDoctorRequired\":\"true\",\"telegramGuard\":\"success\",\"telegramGuardRequired\":\"true\",\"telegramWindows\":\"success\",\"telegramWindowsRequired\":\"true\",\"hasNative\":\"true\",\"hasTasks\":\"true\",\"darwinArm64TabWorkerSmoke\":\"skipped\",\"darwinArm64TabWorkerSmokeRequired\":\"false\"},\"taskIdentities\":[{\"key\":\"one\",\"identity\":\"id-one\"},{\"key\":\"two\",\"identity\":\"id-two\"}],\"childEvidence\":[{\"name\":\".ci-dev-affected-plan.json\",\"sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"},{\"name\":\".ci-dev-shard-receipts/0.json\",\"sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"},{\"name\":\".ci-dev-shard-receipts/1.json\",\"sha256\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\"}]}\n";
		const noShardReceipt = "{\"schemaVersion\":1,\"subject\":\"ci-dev-affected-evidence\",\"manifestSha256\":\"54a4c5abf1fc7a81f2fee152dce6aba6d3838148b8cb0c193a868cf333fc52b2\",\"sourceSha\":\"0123456789abcdef0123456789abcdef01234567\",\"planDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"replayScope\":{\"repository\":\"owner/repo\",\"workflow\":\"Dev CI\",\"runId\":\"42\"}}\n";
		const multiShardReceipt = "{\"schemaVersion\":1,\"subject\":\"ci-dev-affected-evidence\",\"manifestSha256\":\"0b8ee9d2d0d223ee62eb43ad67364116e9d882d08eb84aa3ba9d428a78bdae08\",\"sourceSha\":\"0123456789abcdef0123456789abcdef01234567\",\"planDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"replayScope\":{\"repository\":\"owner/repo\",\"workflow\":\"Dev CI\",\"runId\":\"42\"}}\n";
		const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
		expect(hash(noShardManifest)).toBe("54a4c5abf1fc7a81f2fee152dce6aba6d3838148b8cb0c193a868cf333fc52b2");
		expect(hash(multiShardManifest)).toBe("0b8ee9d2d0d223ee62eb43ad67364116e9d882d08eb84aa3ba9d428a78bdae08");
		expect(hash(noShardReceipt)).toBe("94811782eb24e82ea14b59b600a13f2b0969f50767b300910b8665855f534c19");
		expect(hash(multiShardReceipt)).toBe("09341439a0211c277328dcb07117568d57a3ecddad4d35ae6f03dae57c37e260");
	});
	test("uses a detached finalized evidence producer and artifact-ID consumer", async () => {
		const workflow = await Bun.file(path.join(import.meta.dir, "..", ".github", "workflows", "dev-ci.yml")).text();
		expect(workflow).toContain("affected-evidence-producer:");
		expect(workflow).toContain("name: Affected path validation / evidence producer");
		expect(workflow).toContain("  affected:\n    name: Affected path validation\n    if: ${{ always() }}");
		expect(workflow).toContain("needs: [affected-evidence-producer, affected-plan, affected-native, affected-python-matrix, affected-shards, telegram-daemon-generation, windows-dev-doctor, windows-telegram-daemon-safety, affected-darwin-arm64-tab-worker-smoke]");
		expect(workflow).toContain("artifact_id: ${{ steps.upload-evidence.outputs.artifact-id }}");
		expect(workflow).toContain("artifact_digest: ${{ steps.upload-evidence.outputs.artifact-digest }}");
		expect(workflow).toContain("artifact-ids: ${{ needs.affected-evidence-producer.outputs.artifact_id }}");
		const finalizedDownloadStart = workflow.indexOf("      - name: Download finalized affected evidence");
		const finalizedDownloadEnd = workflow.indexOf("\n      - ", finalizedDownloadStart + 1);
		expect(workflow.slice(finalizedDownloadStart, finalizedDownloadEnd)).toContain("merge-multiple: true");
		const uploadStart = workflow.indexOf("      - name: Upload affected evidence");
		const uploadEnd = workflow.indexOf("\n\n  affected:", uploadStart);
		expect(workflow.slice(uploadStart, uploadEnd)).toContain("overwrite: true");
		expect(workflow).toContain("CI_DEV_EVIDENCE_ROOT: ${{ runner.temp }}/ci-dev-affected-evidence");
		expect(workflow).toContain("rm -rf \"$CI_DEV_EVIDENCE_ROOT\"");
		expect(workflow).toContain("--write-affected-evidence");
		expect(workflow).toContain("--validate-affected-evidence");
		expect(workflow).toContain(".ci-dev-affected-evidence.json");
		expect(workflow).toContain(".ci-dev-affected-evidence.receipt.json");
		expect(workflow).not.toContain("evidencePath");
		expect(workflow).toContain("CI_DEV_TELEGRAM_GUARD_RESULT: ${{ needs.telegram-daemon-generation.result }}");
		expect(workflow).toContain("CI_DEV_TELEGRAM_GUARD_REQUIRED: ${{ needs.affected-plan.outputs.relevant }}");
		expect(workflow).toContain("CI_DEV_TELEGRAM_WINDOWS_RESULT: ${{ needs.windows-telegram-daemon-safety.result }}");
		expect(workflow).toContain("CI_DEV_TELEGRAM_WINDOWS_REQUIRED:");
		expect(workflow).not.toContain("pull_request_target");
		expect(workflow).not.toContain("github.run_attempt");
		expect(workflow).toContain("artifact_digest");
		expect(workflow).toContain("remains a required producer audit binding");
		expect(workflow).not.toContain("continue-on-error");
		const protectedJob = workflow.slice(workflow.indexOf("  affected:\n"), workflow.indexOf("\n  gjc-state-gates-matrix:"));
		expect(protectedJob).toContain("if: ${{ always() }}");
		expect(protectedJob).toContain("name: Validate finalized affected evidence");
		expect(protectedJob).not.toContain("continue-on-error");
		const validationStart = protectedJob.indexOf("name: Validate finalized affected evidence");
		expect(protectedJob.slice(validationStart)).not.toContain("\n        if:");
		const protectedJobEnv = protectedJob.slice(0, protectedJob.indexOf("    steps:"));
		expect(protectedJobEnv).not.toContain("runner.temp");
		const preparationStart = protectedJob.indexOf("name: Fail closed on producer and live dependency results");
		const preparationEnd = protectedJob.indexOf("\n      - name:", preparationStart + 1);
		expect(protectedJob.slice(preparationStart, preparationEnd)).toContain("CI_DEV_EVIDENCE_ROOT: ${{ runner.temp }}/ci-dev-affected-evidence");
		expect(protectedJob.slice(validationStart)).toContain("CI_DEV_EVIDENCE_ROOT: ${{ runner.temp }}/ci-dev-affected-evidence");
	});
	test("gates exact-head Darwin tab-worker evidence through detached affected evidence", async () => {
		const workflow = await Bun.file(path.join(import.meta.dir, "..", ".github", "workflows", "dev-ci.yml")).text();
		expect(workflow).toContain("has_darwin_arm64_tab_worker_smoke: ${{ steps.plan.outputs.has_darwin_arm64_tab_worker_smoke }}");
		expect(workflow).toContain("affected-darwin-arm64-tab-worker-smoke:");
		expect(workflow).toContain("runs-on: macos-14");
		expect(workflow).toContain("TARGET_PLATFORM: darwin");
		expect(workflow).toContain("TARGET_ARCH: arm64");
		expect(workflow).toContain("process.platform");
		expect(workflow).toContain("process.arch");
		expect(workflow).toContain("Write immutable Darwin smoke receipt");
		expect(workflow).toContain("dev-affected-darwin-receipt-${{ github.run_id }}");
		const darwinReceiptUploadStart = workflow.indexOf("      - name: Upload Darwin smoke receipt");
		const darwinReceiptUploadEnd = workflow.indexOf("\n\n  # One shard", darwinReceiptUploadStart);
		expect(workflow.slice(darwinReceiptUploadStart, darwinReceiptUploadEnd)).toContain("overwrite: true");
		expect(workflow).toContain("Download Darwin smoke receipt");
		expect(workflow).toContain("Validate Darwin smoke receipt");
		expect(workflow).toContain(".ci-dev-darwin-arm64-receipt.json");
		expect(workflow).toContain("Validate finalized Darwin smoke receipt");
		expect(workflow).toContain("CI_DEV_DARWIN_ARM64_TAB_WORKER_SMOKE_RESULT");
		expect(workflow).toContain("CI_DEV_DARWIN_ARM64_TAB_WORKER_SMOKE_REQUIRED");
	});

	test("routes the Windows session-path regression suite onto windows-latest and requires it", async () => {
		const workflow = await Bun.file(path.join(import.meta.dir, "..", ".github", "workflows", "dev-ci.yml")).text();
		expect(workflow).toContain("has_windows_session_path: ${{ steps.plan.outputs.has_windows_session_path }}");
		const windowsJob = workflow.slice(workflow.indexOf("  windows-dev-doctor:"), workflow.indexOf("\n  affected-native:"));
		expect(windowsJob).toContain("runs-on: windows-latest");
		expect(windowsJob).toContain("needs.affected-plan.outputs.has_windows_session_path == 'true'");
		expect(windowsJob).toContain("Windows session-path canonicalization regression");
		expect(windowsJob).toContain("bun test packages/coding-agent/test/session-manager/windows-canonical-path.test.ts");
		// The required predicate must textually match the job gate so the aggregate
		// invariant (windowsDoctor === required ? success : skipped) never fails closed.
		const requiredLines = workflow.split("\n").filter(line => line.includes("CI_DEV_WINDOWS_DOCTOR_REQUIRED:"));
		expect(requiredLines.length).toBe(2);
		for (const line of requiredLines) expect(line).toContain("|| needs.affected-plan.outputs.has_windows_session_path == 'true'");
	});

	describe("detached evidence subprocess contract", () => {
		const scriptPath = path.join(import.meta.dir, "ci-dev-affected.ts");
		const repoRoot = path.join(import.meta.dir, "..");
		const sourceSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
		const baseAggregate = {
			plan: "success",
			native: "skipped",
			shards: "skipped",
			python: "skipped",
			windowsDoctor: "skipped",
			windowsDoctorRequired: "false",
			telegramGuard: "skipped",
			telegramGuardRequired: "false",
			telegramWindows: "skipped",
			telegramWindowsRequired: "false",
			hasNative: "false",
			hasTasks: "false",
			hasPython: "false",
			darwinArm64TabWorkerSmoke: "skipped",
			darwinArm64TabWorkerSmokeRequired: "false",
		};
		type EvidenceFixture = { root: string; env: Record<string, string>; plan: string; digest: string };

		async function fixture(tasks: unknown[] = []): Promise<EvidenceFixture> {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-evidence-"));
			const plan = JSON.stringify({ schemaVersion: 1, sourceSha, mode: "pr", paths: [], tasks });
			const digest = new Bun.CryptoHasher("sha256").update(plan).digest("hex");
			await fs.writeFile(path.join(root, ".ci-dev-affected-plan.json"), plan);
			const env: Record<string, string> = {
				CI_DEV_EVIDENCE_ROOT: root, CI_DEV_AFFECTED_PLAN: path.join(root, ".ci-dev-affected-plan.json"), CI_DEV_PLAN_SOURCE_SHA: sourceSha,
				CI_DEV_SOURCE_SHA: sourceSha, CI_DEV_PLAN_DIGEST: digest, CI_DEV_PLAN_MODE: "pr", GITHUB_REPOSITORY: "owner/repo", GITHUB_WORKFLOW: "Dev CI", GITHUB_RUN_ID: "42",
				CI_DEV_PLAN_RESULT: baseAggregate.plan, CI_DEV_NATIVE_RESULT: baseAggregate.native, CI_DEV_SHARDS_RESULT: baseAggregate.shards, CI_DEV_WINDOWS_DOCTOR_RESULT: baseAggregate.windowsDoctor,
				CI_DEV_WINDOWS_DOCTOR_REQUIRED: baseAggregate.windowsDoctorRequired, CI_DEV_HAS_NATIVE: baseAggregate.hasNative, CI_DEV_HAS_TASKS: baseAggregate.hasTasks,
				CI_DEV_PYTHON_RESULT: baseAggregate.python, CI_DEV_HAS_PYTHON: baseAggregate.hasPython,
				CI_DEV_DARWIN_ARM64_TAB_WORKER_SMOKE_RESULT: baseAggregate.darwinArm64TabWorkerSmoke,
				CI_DEV_DARWIN_ARM64_TAB_WORKER_SMOKE_REQUIRED: baseAggregate.darwinArm64TabWorkerSmokeRequired,
				CI_DEV_TELEGRAM_GUARD_RESULT: baseAggregate.telegramGuard,
				CI_DEV_TELEGRAM_GUARD_REQUIRED: baseAggregate.telegramGuardRequired,
				CI_DEV_TELEGRAM_WINDOWS_RESULT: baseAggregate.telegramWindows,
				CI_DEV_TELEGRAM_WINDOWS_REQUIRED: baseAggregate.telegramWindowsRequired,
			};
			return { root, env, plan, digest };
		}
		async function invoke(env: Record<string, string>, command: string) {
			const proc = Bun.spawn(["bun", scriptPath, command], {
				cwd: repoRoot,
				env: {
					...process.env,
					CI_DEV_MATRIX_KEY: undefined,
					CI_DEV_MATRIX_RUST: undefined,
					CI_DEV_MATRIX_NEXTEST: undefined,
					CI_DEV_MATRIX_NATIVE: undefined,
					CI_DEV_MATRIX_IDENTITY: undefined,
					CI_DEV_SHARD_INDEX: undefined,
					AFFECTED_TASK_KEY: undefined,
					...env,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			return { exitCode: await proc.exited, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
		}
		async function withFixture(body: (value: EvidenceFixture) => Promise<void>, tasks: unknown[] = []) {
			const value = await fixture(tasks); try { await body(value); } finally { await fs.rm(value.root, { recursive: true, force: true }); }
		}

		test("produces deterministic no-shard evidence and validates it", async () => {
			await withFixture(async ({ root, env, digest }) => {
				const first = await invoke(env, "--write-affected-evidence");
				expect(first.exitCode).toBe(0); expect(first.stdout).toContain("affected evidence produced: 1 child evidence file(s)");
				const manifest = await fs.readFile(path.join(root, ".ci-dev-affected-evidence.json"), "utf8");
				const receipt = await fs.readFile(path.join(root, ".ci-dev-affected-evidence.receipt.json"), "utf8");
				const expectedManifest = `${JSON.stringify({ schemaVersion: 1, subject: "ci-dev-affected-evidence", sourceSha, planDigest: digest, planMode: "pr", replayScope: { repository: "owner/repo", workflow: "Dev CI", runId: "42" }, aggregateResults: baseAggregate, taskIdentities: [], childEvidence: [{ name: ".ci-dev-affected-plan.json", sha256: digest }] })}\n`;
				expect(manifest).toBe(expectedManifest);
				const expectedReceipt = `${JSON.stringify({ schemaVersion: 1, subject: "ci-dev-affected-evidence", manifestSha256: new Bun.CryptoHasher("sha256").update(expectedManifest).digest("hex"), sourceSha, planDigest: digest, replayScope: { repository: "owner/repo", workflow: "Dev CI", runId: "42" } })}\n`;
				expect(receipt).toBe(expectedReceipt);
				const validated = await invoke(env, "--validate-affected-evidence");
				expect(validated.exitCode).toBe(0); expect(validated.stdout).toContain("affected evidence validated: 1 child evidence file(s)");
				await fs.rm(path.join(root, ".ci-dev-affected-evidence.json")); await fs.rm(path.join(root, ".ci-dev-affected-evidence.receipt.json"));
				expect((await invoke(env, "--write-affected-evidence")).exitCode).toBe(0);
				expect(await fs.readFile(path.join(root, ".ci-dev-affected-evidence.json"), "utf8")).toBe(manifest);
				expect(await fs.readFile(path.join(root, ".ci-dev-affected-evidence.receipt.json"), "utf8")).toBe(receipt);
			});
		});

		test("produces and consumes a complete multi-shard bundle", async () => {
			const task = { key: "fixture-task", identity: "fixture:task", description: "fixture", command: ["true"], cwd: ".", capabilities: { rust: false, nextest: false, nativeConsumer: false, nativeProducer: false }, phase: "legacy" };
			await withFixture(async ({ root, env, digest }) => {
				const multiAggregate = { ...baseAggregate, hasTasks: "true", shards: "success" };
				const multiEnv = { ...env, CI_DEV_HAS_TASKS: multiAggregate.hasTasks, CI_DEV_SHARDS_RESULT: multiAggregate.shards };
				await fs.mkdir(path.join(root, ".ci-dev-shard-receipts"));
				const shardRaw = JSON.stringify({ key: task.key, identity: task.identity });
				await fs.writeFile(path.join(root, ".ci-dev-shard-receipts", "0.json"), shardRaw);
				expect((await invoke(multiEnv, "--write-affected-evidence")).stdout).toContain("affected evidence produced: 2 child evidence file(s)");
				const manifest = await fs.readFile(path.join(root, ".ci-dev-affected-evidence.json"), "utf8");
				const receipt = await fs.readFile(path.join(root, ".ci-dev-affected-evidence.receipt.json"), "utf8");
				const expectedManifest = `${JSON.stringify({ schemaVersion: 1, subject: "ci-dev-affected-evidence", sourceSha, planDigest: digest, planMode: "pr", replayScope: { repository: "owner/repo", workflow: "Dev CI", runId: "42" }, aggregateResults: multiAggregate, taskIdentities: [{ key: task.key, identity: task.identity }], childEvidence: [{ name: ".ci-dev-affected-plan.json", sha256: digest }, { name: ".ci-dev-shard-receipts/0.json", sha256: new Bun.CryptoHasher("sha256").update(shardRaw).digest("hex") }] })}\n`;
				expect(manifest).toBe(expectedManifest);
				const expectedReceipt = `${JSON.stringify({ schemaVersion: 1, subject: "ci-dev-affected-evidence", manifestSha256: new Bun.CryptoHasher("sha256").update(expectedManifest).digest("hex"), sourceSha, planDigest: digest, replayScope: { repository: "owner/repo", workflow: "Dev CI", runId: "42" } })}\n`;
				expect(receipt).toBe(expectedReceipt);
				const consumed = await invoke(multiEnv, "--validate-affected-evidence");
				expect(consumed.exitCode).toBe(0); expect(consumed.stdout).toContain("affected evidence validated: 2 child evidence file(s)");
				await fs.writeFile(path.join(root, ".ci-dev-shard-receipts", "1.json"), "{}");
				expect((await invoke(multiEnv, "--validate-affected-evidence")).exitCode).toBe(1);
			}, [task]);
		});

		test("fails closed for canonical, replay, child, layout, and pair failures", async () => {
			await withFixture(async ({ root, env }) => {
				expect((await invoke(env, "--write-affected-evidence")).exitCode).toBe(0);
				const manifest = path.join(root, ".ci-dev-affected-evidence.json"); const receipt = path.join(root, ".ci-dev-affected-evidence.receipt.json");
				for (const mutate of [
					async () => fs.writeFile(manifest, `${await fs.readFile(manifest, "utf8")}\n`),
					async () => fs.writeFile(receipt, "{}\n"),
					async () => fs.mkdir(path.join(root, ".ci-dev-shard-receipts")),
					async () => fs.writeFile(manifest, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(await fs.readFile(manifest))])),
					async () => fs.writeFile(receipt, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(await fs.readFile(receipt))])),
				]) {
					const originalManifest = await fs.readFile(manifest, "utf8"); const originalReceipt = await fs.readFile(receipt, "utf8"); await mutate();
					expect((await invoke(env, "--validate-affected-evidence")).exitCode).toBe(1);
					await fs.rm(path.join(root, ".ci-dev-shard-receipts"), { recursive: true, force: true }); await fs.writeFile(manifest, originalManifest); await fs.writeFile(receipt, originalReceipt);
				}
				await fs.writeFile(path.join(root, ".ci-dev-affected-plan.json"), "{}");
				expect((await invoke(env, "--validate-affected-evidence")).exitCode).toBe(1);
			}, []);
		});

		test("rejects pre-existing targets and removes its owned manifest after injected receipt failure", async () => {
			await withFixture(async ({ root, env }) => {
				await fs.writeFile(path.join(root, ".ci-dev-affected-evidence.json"), "occupied");
				expect((await invoke(env, "--write-affected-evidence")).exitCode).toBe(1);
				await fs.rm(path.join(root, ".ci-dev-affected-evidence.json"));
				expect((await invoke({ ...env, CI_DEV_INJECT_EVIDENCE_POST_MANIFEST_FAILURE: "true" }, "--write-affected-evidence")).exitCode).toBe(1);
				expect(await Bun.file(path.join(root, ".ci-dev-affected-evidence.json")).exists()).toBe(false);
				expect(await Bun.file(path.join(root, ".ci-dev-affected-evidence.receipt.json")).exists()).toBe(false);
			});
		});

		test("rejects replay, source, aggregate, task, child, and filesystem substitutions", async () => {
			await withFixture(async ({ root, env }) => {
				expect((await invoke(env, "--write-affected-evidence")).exitCode).toBe(0);
				const manifestPath = path.join(root, ".ci-dev-affected-evidence.json"); const receiptPath = path.join(root, ".ci-dev-affected-evidence.receipt.json");
				const originalManifest = await fs.readFile(manifestPath, "utf8"); const originalReceipt = await fs.readFile(receiptPath, "utf8");
				async function resign(mutator: (manifest: Record<string, unknown>) => void) {
					const manifest = JSON.parse(originalManifest) as Record<string, unknown>; mutator(manifest);
					const raw = `${JSON.stringify(manifest)}\n`; const digest = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
					const receipt = JSON.parse(originalReceipt) as Record<string, unknown>; receipt.manifestSha256 = digest;
					await fs.writeFile(manifestPath, raw); await fs.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
					expect((await invoke(env, "--validate-affected-evidence")).exitCode).toBe(1);
					await fs.writeFile(manifestPath, originalManifest); await fs.writeFile(receiptPath, originalReceipt);
				}
				await resign(manifest => { delete (manifest.aggregateResults as Record<string, string>).hasPython; });
				await resign(manifest => { delete (manifest.aggregateResults as Record<string, string>).python; });
				await resign(manifest => { (manifest.replayScope as Record<string, string>).runId = "stale"; });
				await resign(manifest => { manifest.sourceSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd"; });
				await resign(manifest => { (manifest.aggregateResults as Record<string, string>).plan = "failure"; });
				await resign(manifest => { manifest.taskIdentities = [{ key: "extra", identity: "extra" }]; });
				await resign(manifest => { (manifest.childEvidence as Array<Record<string, string>>)[0]!.sha256 = "a".repeat(64); });
				await fs.rm(manifestPath); await fs.symlink(receiptPath, manifestPath);
				expect((await invoke(env, "--validate-affected-evidence")).exitCode).toBe(1);
				await fs.rm(manifestPath); await fs.mkdir(manifestPath);
				expect((await invoke(env, "--validate-affected-evidence")).exitCode).toBe(1);
			});
		});

		test("requires an explicit existing evidence root and rejects plan mode and capability drift", async () => {
			const absent = path.join(os.tmpdir(), `ci-dev-evidence-absent-${Date.now()}`);
			expect((await invoke({ CI_DEV_EVIDENCE_ROOT: absent }, "--validate-affected-evidence")).exitCode).toBe(1);
			await withFixture(async ({ root, env }) => {
				expect((await invoke({ ...env, CI_DEV_PLAN_MODE: "push" }, "--write-affected-evidence")).exitCode).toBe(1);
			}, []);
			const nativeTask = { key: "native-only", identity: "native-only", description: "native", command: ["true"], cwd: ".", capabilities: { rust: false, nextest: false, nativeConsumer: false, nativeProducer: true }, phase: "native-producer" };
			await withFixture(async ({ root, env }) => {
				expect((await invoke(env, "--write-affected-evidence")).exitCode).toBe(1);
				expect((await invoke({ ...env, CI_DEV_HAS_NATIVE: "true", CI_DEV_NATIVE_RESULT: "success" }, "--write-affected-evidence")).exitCode).toBe(0);
			}, [nativeTask]);
			const regularTask = { key: "regular", identity: "regular", description: "regular", command: ["true"], cwd: ".", capabilities: { rust: false, nextest: false, nativeConsumer: false, nativeProducer: false }, phase: "legacy" };
			await withFixture(async ({ root, env }) => {
				expect((await invoke({ ...env, CI_DEV_HAS_TASKS: "false", CI_DEV_SHARDS_RESULT: "skipped" }, "--write-affected-evidence")).exitCode).toBe(1);
			}, [regularTask]);
		});

		test("rejects unknown nested schemas, pair swaps, and receipt-side disagreement", async () => {
			await withFixture(async ({ root, env }) => {
				expect((await invoke(env, "--write-affected-evidence")).exitCode).toBe(0);
				const manifestPath = path.join(root, ".ci-dev-affected-evidence.json"); const receiptPath = path.join(root, ".ci-dev-affected-evidence.receipt.json");
				const manifest = await fs.readFile(manifestPath, "utf8"); const receipt = await fs.readFile(receiptPath, "utf8");
				for (const mutate of [
					async () => fs.writeFile(manifestPath, `${JSON.stringify({ ...JSON.parse(manifest), unknown: true })}\n`),
					async () => {
						const decoded = JSON.parse(manifest) as Record<string, unknown>;
						decoded.replayScope = { ...(decoded.replayScope as Record<string, unknown>), unknown: true };
						await fs.writeFile(manifestPath, `${JSON.stringify(decoded)}\n`);
					},
					async () => {
						const decoded = JSON.parse(manifest) as Record<string, unknown>;
						decoded.aggregateResults = { ...(decoded.aggregateResults as Record<string, unknown>), unknown: true };
						await fs.writeFile(manifestPath, `${JSON.stringify(decoded)}\n`);
					},
					async () => fs.writeFile(receiptPath, `${JSON.stringify({ ...JSON.parse(receipt), sourceSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" })}\n`),
					async () => { await fs.writeFile(manifestPath, receipt); await fs.writeFile(receiptPath, manifest); },
				]) {
					await mutate(); expect((await invoke(env, "--validate-affected-evidence")).exitCode).toBe(1);
					await fs.writeFile(manifestPath, manifest); await fs.writeFile(receiptPath, receipt);
				}
			});
		});

		test("rejects malformed UTF-8 evidence bytes", async () => {
			await withFixture(async ({ root, env }) => {
				expect((await invoke(env, "--write-affected-evidence")).exitCode).toBe(0);
				await fs.writeFile(path.join(root, ".ci-dev-affected-evidence.json"), Uint8Array.from([0xff]));
				expect((await invoke(env, "--validate-affected-evidence")).exitCode).toBe(1);
			});
		});
	});

	test("aggregate result truth table rejects every missing, failed, cancelled, and unplanned dependency", () => {
		const valid: AffectedAggregateResults[] = [
			{ plan: "success", native: "success", shards: "success", python: "success", windowsDoctor: "success", windowsDoctorRequired: "true", telegramGuard: "success", telegramGuardRequired: "true", telegramWindows: "success", telegramWindowsRequired: "true", hasNative: "true", hasTasks: "true", hasPython: "true", darwinArm64TabWorkerSmoke: "success", darwinArm64TabWorkerSmokeRequired: "true" },
			{ plan: "success", native: "skipped", shards: "skipped", python: "skipped", windowsDoctor: "skipped", windowsDoctorRequired: "false", telegramGuard: "skipped", telegramGuardRequired: "false", telegramWindows: "skipped", telegramWindowsRequired: "false", hasNative: "false", hasTasks: "false", hasPython: "false", darwinArm64TabWorkerSmoke: "skipped", darwinArm64TabWorkerSmokeRequired: "false" },
			{ plan: "success", native: "success", shards: "skipped", python: "skipped", windowsDoctor: "skipped", windowsDoctorRequired: "false", telegramGuard: "success", telegramGuardRequired: "true", telegramWindows: "success", telegramWindowsRequired: "true", hasNative: "true", hasTasks: "false", hasPython: "false", darwinArm64TabWorkerSmoke: "skipped", darwinArm64TabWorkerSmokeRequired: "false" },
			{ plan: "success", native: "skipped", shards: "success", python: "skipped", windowsDoctor: "success", windowsDoctorRequired: "true", telegramGuard: "success", telegramGuardRequired: "true", telegramWindows: "success", telegramWindowsRequired: "true", hasNative: "false", hasTasks: "true", hasPython: "false", darwinArm64TabWorkerSmoke: "skipped", darwinArm64TabWorkerSmokeRequired: "false" },
		];
		for (const results of valid) expect(() => validateAffectedAggregate(results)).not.toThrow();

		for (const results of [
			{ ...valid[0]!, plan: "failure" },
			{ ...valid[0]!, plan: "cancelled" },
			{ ...valid[0]!, native: "failure" },
			{ ...valid[0]!, native: "cancelled" },
			{ ...valid[0]!, shards: "failure" },
			{ ...valid[0]!, shards: "cancelled" },
			{ ...valid[0]!, shards: "skipped" },
			{ ...valid[0]!, windowsDoctor: "failure" },
			{ ...valid[0]!, windowsDoctor: "cancelled" },
			{ ...valid[0]!, windowsDoctor: "skipped" },
			{ ...valid[0]!, darwinArm64TabWorkerSmoke: "failure" },
			{ ...valid[0]!, darwinArm64TabWorkerSmoke: "cancelled" },
			{ ...valid[0]!, darwinArm64TabWorkerSmoke: "skipped" },
			{ ...valid[1]!, darwinArm64TabWorkerSmoke: "success" },
			{ ...valid[1]!, darwinArm64TabWorkerSmokeRequired: "" },
			{ ...valid[1]!, darwinArm64TabWorkerSmokeRequired: "maybe" },
			{ ...valid[0]!, telegramGuard: "failure" },
			{ ...valid[0]!, telegramGuard: "cancelled" },
			{ ...valid[0]!, telegramGuard: "skipped" },
			{ ...valid[0]!, telegramWindows: "failure" },
			{ ...valid[0]!, telegramWindows: "cancelled" },
			{ ...valid[0]!, telegramWindows: "skipped" },
			{ ...valid[1]!, telegramGuardRequired: "" },
			{ ...valid[1]!, telegramGuardRequired: "maybe" },
			{ ...valid[1]!, telegramWindowsRequired: "" },
			{ ...valid[1]!, telegramWindowsRequired: "maybe" },
			{ ...valid[1]!, windowsDoctor: "success" },
			{ ...valid[1]!, telegramGuard: "success" },
			{ ...valid[1]!, telegramWindows: "success" },
			{ ...valid[1]!, windowsDoctorRequired: "" },
			{ ...valid[1]!, windowsDoctorRequired: "maybe" },
			{ ...valid[1]!, hasNative: "" },
			{ ...valid[1]!, hasTasks: "maybe" },
			{ ...valid[1]!, hasPython: "maybe" },
			{ ...valid[0]!, python: "skipped" },
			{ ...valid[1]!, python: "success" },
			{ ...valid[1]!, native: "success" },
			{ ...valid[1]!, shards: "success" },
		])
			expect(() => validateAffectedAggregate(results)).toThrow();
	});
});

	describe("deep-interview selector narrowing", () => {
		test("deep-interview-only changes avoid full workspace validation but still provide native artifacts", () => {
			const tasks = planForPaths([
				"packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md",
				"packages/coding-agent/src/gjc-runtime/deep-interview-runtime.ts",
				"packages/coding-agent/test/default-gjc-definitions.test.ts",
				"packages/coding-agent/test/gjc-runtime/deep-interview-runtime.test.ts",
			]);
			expect(tasks.map(task => task.key)).toEqual([
				"native-linux-x64",
				"deep-interview-definitions",
				"deep-interview-runtime",
			]);
			const entries = describeTasks(tasks);
			expect(entries.find(entry => entry.key === "native-linux-x64")?.nativeBuild).toBe(true);
			expect(entries.find(entry => entry.key === "deep-interview-definitions")?.native).toBe(true);
			expect(entries.find(entry => entry.key === "deep-interview-runtime")?.native).toBe(true);
			expect(tasks.some(task => task.key === "root-test")).toBe(false);
		});
	});

describe("runCommand executes package scripts in the target cwd (issue #622)", () => {
	const tempDirs: string[] = [];

	afterAll(async () => {
		await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	async function makePackage(): Promise<{ pkgDir: string; markerPath: string }> {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-"));
		tempDirs.push(tempDir);
		const pkgDir = path.join(tempDir, "pkg");
		await fs.mkdir(pkgDir, { recursive: true });
		const marker = "ran.marker";
		await fs.writeFile(
			path.join(pkgDir, "package.json"),
			JSON.stringify({
				name: "marker-pkg",
				scripts: {
					check: `node -e "require('node:fs').writeFileSync('${marker}','ran')"`,
					fail: "node -e \"process.exit(3)\"",
				},
			}),
		);
		return { pkgDir, markerPath: path.join(pkgDir, marker) };
	}

	test("the produced command actually runs the package script", async () => {
		const { pkgDir, markerPath } = await makePackage();
		const exitCode = await runCommand(packageScriptCommand("check"), pkgDir);
		expect(exitCode).toBe(0);
		expect(await Bun.file(markerPath).exists()).toBe(true);
	});

	test("a failing package script propagates its non-zero exit code", async () => {
		const { pkgDir } = await makePackage();
		const exitCode = await runCommand(packageScriptCommand("fail"), pkgDir);
		expect(exitCode).toBe(3);
	});

	test("the legacy `bun --cwd <dir>` form is a false green: exits 0 without running the script", async () => {
		const { pkgDir, markerPath } = await makePackage();
		// Spawn the buggy shape directly (captured, so the usage banner does not
		// flood test output) from a cwd that is NOT the package directory.
		const proc = Bun.spawn(["bun", "--cwd", pkgDir, "run", "check"], {
			cwd: os.tmpdir(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const output = stdout + stderr;
		expect(exitCode).toBe(0); // false green
		expect(await Bun.file(markerPath).exists()).toBe(false); // script never ran
		expect(output).toContain("Usage: bun run"); // it only printed help
	});
});

describe("describeTasks matrix emission", () => {
	test("package test task needs native, native build task is flagged, check does not", () => {
		const entries = describeTasks(planForPaths(["packages/example/src/index.ts"]));
		const nativeBuild = entries.find(entry => entry.key === "native-linux-x64");
		const pkgTest = entries.find(entry => entry.key === "test:@gajae-code/example");
		const pkgCheck = entries.find(entry => entry.key === "check:@gajae-code/example");

		expect(nativeBuild?.nativeBuild).toBe(true);
		expect(nativeBuild?.native).toBe(false);
		expect(pkgTest?.native).toBe(true);
		expect(pkgTest?.nativeBuild).toBe(false);
		expect(pkgCheck?.native).toBe(false);
		expect(pkgCheck?.nativeBuild).toBe(false);

		// Every descriptor carries the serialized command plus boolean setup flags.
		for (const entry of entries) {
			expect(Array.isArray(entry.command)).toBe(true);
			expect(typeof entry.native).toBe("boolean");
			expect(typeof entry.rust).toBe("boolean");
			expect(typeof entry.nativeBuild).toBe("boolean");
		}
	});

	test("full-workspace root-check downloads the native artifact used by generated checks", () => {
		const entries = describeTasks(planTasks(["tsconfig.json"], packages));
		const nativeBuild = entries.find(entry => entry.key === "native-linux-x64");
		const rootCheck = entries.find(entry => entry.key === "root-check");

		expect(nativeBuild?.nativeBuild).toBe(true);
		expect(rootCheck).toMatchObject({ command: ["bun", "run", "ci:check:full"], native: true, nativeBuild: false });
	});

	test("rust tasks are flagged rust and need no native addon", () => {
		const entries = describeTasks(planTasks(["crates/pi-natives/src/lib.rs"], packages));
		const check = entries.find(entry => entry.key === "rust-check");
		const runTest = entries.find(entry => entry.key === "rust-test");

		expect(check?.rust).toBe(true);
		expect(check?.native).toBe(false);
		expect(runTest?.rust).toBe(true);
		expect(entries.every(entry => !entry.nativeBuild)).toBe(true);
	});

	test("selector self-check shards provision Rust without nextest in PR and push plans", () => {
		const entries = [
			...describeTasks(planTargetedTasks(["scripts/ci-dev-affected.ts"], packages, [])),
			...describeTasks(planTasks(["scripts/ci-dev-affected.ts"], packages)),
		];
		for (const key of ["ci-selftest", "ci-dry-run", "affected-selftest", "affected-dry-run"]) {
			expect(entries.find(entry => entry.key === key)).toMatchObject({ rust: true, nextest: false });
		}
	});

	test("push affected selftest runs selector and topology coverage for workflow and topology changes", () => {
		for (const changedPath of [".github/workflows/dev-ci.yml", "scripts/dev-ci-guard-topology.test.ts"]) {
			const task = planTasks([changedPath], packages).find(candidate => candidate.key === "affected-selftest");
			expect(task?.command).toEqual([
				"bun",
				"test",
				"scripts/ci-dev-affected.test.ts",
				"scripts/dev-ci-guard-topology.test.ts",
			]);
		}
	});

	test("cwd is emitted repo-relative for package-scoped tasks", () => {
		const entries = describeTasks(planForPaths(["packages/example/src/index.ts"]));
		const pkgCheck = entries.find(entry => entry.key === "check:@gajae-code/example");
		expect(pkgCheck?.cwd).toBe("packages/example");
	});
});

describe("--matrix-json and --task CLI fan-out", () => {
	const scriptPath = path.join(import.meta.dir, "ci-dev-affected.ts");
	const repoRoot = path.join(import.meta.dir, "..");
	const tempDirs: string[] = [];
	const sourceSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();

	afterAll(async () => {
		await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
		await fs.rm(path.join(repoRoot, ".ci-dev-affected-plan.json"), { force: true });
	});

	async function runScript(
		args: readonly string[],
		changedPaths: string,
		extraEnv: Record<string, string | undefined> = {},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const proc = Bun.spawn(["bun", scriptPath, ...args], {
			cwd: repoRoot,
			// Default to push (broad) mode so these CLI cases stay deterministic
			// regardless of the GITHUB_EVENT_NAME/CI_DEV_PLAN_MODE of the CI run
			// executing them; PR-mode behavior is asserted via planTargetedTasks unit
			// tests and explicit shard-mode cases.
			env: {
				...process.env,
				CI_DEV_AFFECTED_PLAN: undefined,
				CI_DEV_PLAN_DIGEST: undefined,
				CI_DEV_PLAN_SOURCE_SHA: undefined,
				GITHUB_SHA: undefined,
				CI_DEV_SOURCE_SHA: sourceSha,
				CI_DEV_MATRIX_IDENTITY: undefined,
				CI_DEV_MATRIX_KEY: undefined,
				CI_DEV_MATRIX_NATIVE: undefined,
				CI_DEV_MATRIX_NEXTEST: undefined,
				CI_DEV_MATRIX_RUST: undefined,
				CI_DEV_SHARD_INDEX: undefined,
				CI_DEV_SHARD_RECEIPTS: undefined,
				AFFECTED_TASK_KEY: undefined,
				GITHUB_EVENT_NAME: "push",
				CI_DEV_PLAN_MODE: "push",
				CI_DEV_CHANGED_PATHS: changedPaths,
				...extraEnv,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	}

	test("--matrix-json emits JSON descriptors and GitHub planner outputs", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-matrix-"));
		tempDirs.push(tempDir);
		const outputFile = path.join(tempDir, "github-output.txt");

		const { stdout, exitCode } = await runScript(["--matrix-json"], "crates/pi-natives/src/lib.rs", {
			GITHUB_OUTPUT: outputFile,
		});
		expect(exitCode).toBe(0);

		const entries = JSON.parse(stdout.trim());
		expect(entries.some((entry: { key: string; rust: boolean; native: boolean }) => entry.key === "rust-check" && entry.rust === true && entry.native === false)).toBe(true);
		expect(entries.some((entry: { key: string; rust: boolean; nativeBuild: boolean }) => entry.key.startsWith("cargo-build:") && entry.rust === true && entry.nativeBuild === false)).toBe(true);
		expect(entries.filter((entry: { key: string }) => entry.key === "native-linux-x64")).toHaveLength(1);

		const output = await Bun.file(outputFile).text();
		expect(output).toContain("has_tasks=true");
		expect(output).toContain("has_python=false");
		expect(output).toContain("has_native=true");
		expect(output).toContain("changed_paths<<");

		const matrixLine = output.split("\n").find(line => line.startsWith("matrix="));
		expect(matrixLine).toBeDefined();
		const matrix = JSON.parse((matrixLine as string).slice("matrix=".length));
		expect(matrix.include.some((shard: { key: string }) => shard.key === "rust-check")).toBe(true);
		expect(matrix.include.some((shard: { key: string }) => shard.key.startsWith("cargo-build:"))).toBe(true);
		// Native build tasks never appear as shards.
		expect(matrix.include.every((shard: { key: string }) => shard.key !== "native-linux-x64")).toBe(true);
	});
	test("CI_FORCE_FULL emits Python work outside the shard matrix", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-python-full-"));
		tempDirs.push(tempDir);
		const outputFile = path.join(tempDir, "github-output.txt");
		const { stdout, exitCode } = await runScript(["--matrix-json"], "", { CI_FORCE_FULL: "1", GITHUB_OUTPUT: outputFile });
		expect(exitCode).toBe(0);
		expect((JSON.parse(stdout.trim()) as Array<{ key: string }>).filter(entry => entry.key.startsWith("python-"))).toHaveLength(3);
		const output = await Bun.file(outputFile).text();
		expect(output).toContain("has_python=true");
		const matrix = JSON.parse((output.split("\n").find(line => line.startsWith("matrix=")) ?? "matrix={}").slice("matrix=".length));
		expect(matrix.include.some((entry: { key: string }) => entry.key.startsWith("python-"))).toBe(false);
	});

	test("changed-path ranges use the canonical source head instead of ambient PR merge SHA", async () => {
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
		// The affected-shard checkout intentionally contains only the canonical source
		// commit. Reusing it as the base proves source-head authority without assuming
		// that unrelated parent or remote refs exist in the shallow checkout.
		const base = head;
		const missingMergeSha = "1".repeat(40);
		const pr = await runScript(["--matrix-json"], "", {
			GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "", GITHUB_BASE_SHA: base,
			GITHUB_SHA: missingMergeSha, CI_DEV_SOURCE_SHA: head,
		});
		expect(pr.exitCode).toBe(0);

		const push = await runScript(["--matrix-json"], "", {
			GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: base, GITHUB_BASE_SHA: "",
			GITHUB_SHA: missingMergeSha, CI_DEV_SOURCE_SHA: head,
		});
		expect(push.exitCode).toBe(0);

		const missingHead = await runScript(["--matrix-json"], "", {
			GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "", GITHUB_BASE_SHA: base,
			GITHUB_SHA: head, CI_DEV_SOURCE_SHA: "2".repeat(40),
		});
		expect(missingHead.exitCode).toBe(1);
		expect(missingHead.stderr).toContain("source head");
		expect(missingHead.stderr).toContain("is not available");
	});

	test("PR planning uses the event base SHA when the mutable base ref has moved", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-pr-base-"));
		tempDirs.push(tempDir);
		const outputFile = path.join(tempDir, "github-output.txt");
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
		// Shard checkouts are depth-one, so use the canonical head as an available
		// event-base commit while the mutable base ref deliberately does not exist.
		const base = head;
		const result = await runScript(["--matrix-json"], "", {
			GITHUB_EVENT_NAME: "pull_request",
			GITHUB_BASE_REF: "ci-dev-affected-base-ref-moved",
			GITHUB_BASE_SHA: base,
			GITHUB_SHA: "f".repeat(40),
			CI_DEV_SOURCE_SHA: head,
			GITHUB_OUTPUT: outputFile,
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toBeInstanceOf(Array);
		const output = await Bun.file(outputFile).text();
		expect(output).toContain(`plan_source_sha=${head}`);
		expect(output).toContain("plan_digest=");
		expect(await Bun.file(path.join(repoRoot, ".ci-dev-affected-plan.json")).exists()).toBe(true);
	});
	test("Cargo selection includes transitive dependents and never emits vendored shards", async () => {
		const sdk = await runScript(["--matrix-json"], "crates/gjc-sdk/src/lib.rs");
		expect(sdk.exitCode).toBe(0);
		const sdkKeys = (JSON.parse(sdk.stdout.trim()) as Array<{ key: string }>).map(entry => entry.key);
		expect(sdkKeys.filter(key => key.startsWith("cargo-build:"))).toEqual([
			"cargo-build:cargo:Z2pjLXNkaw:Y3JhdGVzL2dqYy1zZGsvQ2FyZ28udG9tbA",
			"cargo-build:cargo:cGktbmF0aXZlcw:Y3JhdGVzL3BpLW5hdGl2ZXMvQ2FyZ28udG9tbA",
		]);
		expect(sdkKeys.filter(key => key === "native-linux-x64")).toHaveLength(1);

		const vendored = await runScript(["--matrix-json"], "crates/brush-core-vendored/src/lib.rs");
		expect(vendored.exitCode).toBe(0);
		const vendoredKeys = (JSON.parse(vendored.stdout.trim()) as Array<{ key: string }>).map(entry => entry.key);
		expect(vendoredKeys.filter(key => key.startsWith("cargo-build:"))).toHaveLength(5);
		expect(vendoredKeys.some(key => key.includes("brush"))).toBe(false);
	});

	test("root/shared build inputs select every inventory TypeScript build in stable order", async () => {
		const { stdout, exitCode } = await runScript(["--matrix-json"], "bun.lock");
		expect(exitCode).toBe(0);
		const entries = JSON.parse(stdout.trim()) as Array<{ key: string }>;
		expect(entries.filter(entry => entry.key.startsWith("ts-build:")).map(entry => entry.key)).toEqual([
			"ts-build:ts:Y29kaW5nLWFnZW50:cGFja2FnZXMvY29kaW5nLWFnZW50",
			"ts-build:ts:c3RhdHM:cGFja2FnZXMvc3RhdHM",
		]);
	});

	test("package documentation changes do not schedule build shards", async () => {
		const { stdout, exitCode } = await runScript(["--matrix-json"], "packages/coding-agent/README.md", {
			CI_DEV_PLAN_MODE: "pr",
			PATH: `${path.dirname(Bun.which("bun") ?? process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
		});
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual([]);
	});

	test("unknown unowned inputs fail open to every TypeScript and Cargo build family", async () => {
		for (const changedPath of ["Makefile", "packages/new-workspace/src/index.ts"]) {
			const { stdout, exitCode } = await runScript(["--matrix-json"], changedPath);
			expect(exitCode).toBe(0);
			const entries = JSON.parse(stdout.trim()) as Array<{ key: string }>;
			expect(entries.filter(entry => entry.key.startsWith("ts-build:")).map(entry => entry.key)).toHaveLength(2);
			expect(entries.filter(entry => entry.key.startsWith("cargo-build:")).map(entry => entry.key)).toHaveLength(5);
			expect(entries.filter(entry => entry.key === "native-linux-x64")).toHaveLength(1);
		}
	});

	test("native workspace changes have exact PR and push plans", async () => {
		const pr = await runScript(["--matrix-json"], "packages/natives/src/index.ts", { CI_DEV_PLAN_MODE: "pr" });
		expect(pr.exitCode).toBe(0);
		expect((JSON.parse(pr.stdout.trim()) as Array<{ key: string }>).map(entry => entry.key)).toEqual([
			"check:@gajae-code/natives",
			"install-methods",
			"native-linux-x64",
			"ts-build:ts:Y29kaW5nLWFnZW50:cGFja2FnZXMvY29kaW5nLWFnZW50",
			"ts-build:ts:c3RhdHM:cGFja2FnZXMvc3RhdHM",
		]);

		const push = await runScript(["--matrix-json"], "packages/natives/src/index.ts", { CI_DEV_PLAN_MODE: "push" });
		expect(push.exitCode).toBe(0);
		expect((JSON.parse(push.stdout.trim()) as Array<{ key: string }>).map(entry => entry.key)).toEqual([
			"check:@gajae-code/agent-core", "test:@gajae-code/agent-core",
			"check:@gajae-code/ai", "test:@gajae-code/ai",
			"check:@gajae-code/coding-agent",
			...Array.from({ length: 8 }, (_, index) => `test:@gajae-code/coding-agent:shard-${index + 1}-of-8`),
			"check:@gajae-code/natives", "test:@gajae-code/natives",
			"check:@gajae-code/stats",
			"check:@gajae-code/tui", "test:@gajae-code/tui",
			"check:@gajae-code/typescript-edit-benchmark", "test:@gajae-code/typescript-edit-benchmark",
			"check:@gajae-code/utils", "test:@gajae-code/utils",
			"install-methods",
			"native-linux-x64",
			"ts-build:ts:Y29kaW5nLWFnZW50:cGFja2FnZXMvY29kaW5nLWFnZW50",
			"ts-build:ts:c3RhdHM:cGFja2FnZXMvc3RhdHM",
		]);
	});

	test("canonical plan validation binds exact bytes and source head", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-plan-"));
		tempDirs.push(tempDir);
		const outputFile = path.join(tempDir, "github-output.txt");
		const planFile = path.join(tempDir, "plan.json");
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
		const generated = await runScript(["--matrix-json"], "packages/stats/src/index.ts", {
			GITHUB_OUTPUT: outputFile,
			CI_DEV_SOURCE_SHA: head,
		});
		expect(generated.exitCode).toBe(0);
		await Bun.write(planFile, Bun.file(path.join(repoRoot, ".ci-dev-affected-plan.json")));
		const output = await Bun.file(outputFile).text();
		const digest = output.split("\n").find(line => line.startsWith("plan_digest="))?.slice("plan_digest=".length);
		expect(digest).toBeDefined();
		const valid = await runScript(["--validate-plan"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
		});
		expect(valid.exitCode).toBe(0);
		const receiptDir = path.join(tempDir, "receipts");
		await fs.mkdir(receiptDir);
		const plan = JSON.parse(await Bun.file(planFile).text()) as { tasks: Array<{ key: string; identity: string; capabilities: { nativeProducer: boolean } }> };
		const expectedShards = plan.tasks.filter(task => !task.capabilities.nativeProducer);
		for (const [index, task] of expectedShards.entries()) {
			await Bun.write(path.join(receiptDir, `${index}.json`), JSON.stringify({ key: task.key, identity: task.identity }));
		}
		const receiptsValid = await runScript(["--validate-shard-receipts"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
			CI_DEV_SHARD_RECEIPTS: receiptDir,
		});
		expect(receiptsValid.exitCode).toBe(0);
		await fs.rm(path.join(receiptDir, "0.json"));
		const receiptMissing = await runScript(["--validate-shard-receipts"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
			CI_DEV_SHARD_RECEIPTS: receiptDir,
		});
		expect(receiptMissing.exitCode).toBe(1);
		expect(receiptMissing.stderr).toContain("shard receipt set does not match canonical plan");
		await Bun.write(path.join(receiptDir, "0.json"), JSON.stringify({ key: expectedShards[0]!.key, identity: expectedShards[0]!.identity }));
		await Bun.write(path.join(receiptDir, "stale-extra.json"), JSON.stringify({ key: "stale", identity: "stale" }));
		const receiptExtra = await runScript(["--validate-shard-receipts"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
			CI_DEV_SHARD_RECEIPTS: receiptDir,
		});
		expect(receiptExtra.exitCode).toBe(1);
		expect(receiptExtra.stderr).toContain("shard receipt set does not match canonical plan");
		await fs.rm(path.join(receiptDir, "stale-extra.json"));
		await Bun.write(path.join(receiptDir, "duplicate.json"), JSON.stringify({ key: expectedShards[0]!.key, identity: expectedShards[0]!.identity }));
		const receiptDuplicate = await runScript(["--validate-shard-receipts"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
			CI_DEV_SHARD_RECEIPTS: receiptDir,
		});
		expect(receiptDuplicate.exitCode).toBe(1);
		expect(receiptDuplicate.stderr).toContain("shard receipt set does not match canonical plan");
		await fs.rm(path.join(receiptDir, "duplicate.json"));
		await Bun.write(path.join(receiptDir, "0.json"), JSON.stringify({ key: expectedShards[0]!.key, identity: "wrong" }));
		const receiptWrongIdentity = await runScript(["--validate-shard-receipts"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
			CI_DEV_SHARD_RECEIPTS: receiptDir,
		});
		expect(receiptWrongIdentity.exitCode).toBe(1);
		expect(receiptWrongIdentity.stderr).toContain("shard receipt set does not match canonical plan");
		await Bun.write(path.join(receiptDir, "0.json"), "{");
		const receiptMalformedJson = await runScript(["--validate-shard-receipts"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
			CI_DEV_SHARD_RECEIPTS: receiptDir,
		});
		expect(receiptMalformedJson.exitCode).toBe(1);
		await Bun.write(path.join(receiptDir, "0.json"), JSON.stringify({ key: expectedShards[0]!.key, identity: expectedShards[0]!.identity, extra: true }));
		const receiptMalformedObject = await runScript(["--validate-shard-receipts"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
			CI_DEV_SHARD_RECEIPTS: receiptDir,
		});
		expect(receiptMalformedObject.exitCode).toBe(1);
		expect(receiptMalformedObject.stderr).toContain("malformed shard receipt");
		const wrongSource = await runScript(["--validate-plan"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: "0".repeat(40),
		});
		expect(wrongSource.exitCode).toBe(1);
		expect(wrongSource.stderr).toContain("source SHA mismatch");

		const matrixEntry = (JSON.parse(generated.stdout.trim()) as Array<{ key: string; rust: boolean; nextest: boolean; native: boolean }>).find(entry => !entry.key.startsWith("native-linux-x64"));
		expect(matrixEntry).toBeDefined();
		const wrongCapabilities = await runScript(["--validate-plan"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
			CI_DEV_MATRIX_KEY: matrixEntry?.key as string,
			CI_DEV_MATRIX_RUST: String(!(matrixEntry?.rust ?? false)),
			CI_DEV_MATRIX_NEXTEST: String(matrixEntry?.nextest ?? false),
			CI_DEV_MATRIX_NATIVE: String(matrixEntry?.native ?? false),
		});
		expect(wrongCapabilities.exitCode).toBe(1);
		expect(wrongCapabilities.stderr).toContain("matrix capabilities mismatch");
		await Bun.write(planFile, `${await Bun.file(planFile).text()}\n`);
		const tampered = await runScript(["--validate-plan"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
		});
		expect(tampered.exitCode).toBe(1);
		expect(tampered.stderr).toContain("digest mismatch");
	});

	test("--task runs exactly the selected planned task", async () => {
		const { stdout, exitCode } = await runScript(["--task=affected-dry-run"], "scripts/ci-dev-affected.ts");
		expect(exitCode).toBe(0);
		// The selected task's group header proves the right single task was chosen,
		// and the nested --dry-run output proves it actually executed.
		expect(stdout).toContain("Affected CI selector self-check");
		expect(stdout).toContain("Dev affected-path CI");
	});

	test("--task fails loudly on a key absent from the current plan", async () => {
		const { stderr, exitCode } = await runScript(["--task=does-not-exist"], "docs/readme.md");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("not in the current plan");
	});

	test("--native-build is a no-op when the plan has no native build task", async () => {
		const { stdout, exitCode } = await runScript(["--native-build"], "docs/readme.md");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("no native build tasks in plan");
	});
});

describe("planTargetedTasks PR-mode targeting", () => {
	const codingAgent: WorkspacePackage = {
		name: "@gajae-code/coding-agent",
		dir: "packages/coding-agent",
		manifest: { name: "@gajae-code/coding-agent", scripts: { check: "biome check .", test: "bun test" } },
	};
	const bridgeClient: WorkspacePackage = {
		name: "@gajae-code/bridge-client",
		dir: "packages/bridge-client",
		manifest: { name: "@gajae-code/bridge-client", scripts: { check: "biome check .", test: "bun test" } },
	};
	const targetingPackages: WorkspacePackage[] = [codingAgent, bridgeClient];
	const testFiles = [
		"packages/coding-agent/test/edit/foo.test.ts",
		"packages/coding-agent/test/edit/bar.test.ts",
		"packages/coding-agent/test/cli.test.ts",
		"packages/coding-agent/test/rlm-live-model-e2e.test.ts",
		"packages/coding-agent/test/startup-update-contract.test.ts",
		"packages/coding-agent/test/sdk-host-wiring.test.ts",
		"packages/coding-agent/test/sdk/index.test.ts",
		"packages/coding-agent/test/other/index.test.ts",
		"packages/bridge-client/test/client.test.ts",
	];

	function targeted(paths: readonly string[]) {
		return planTargetedTasks(paths, targetingPackages, testFiles);
	}

	test("a single coding-agent test change runs only that test, not the whole package suite", () => {
		const tasks = targeted(["packages/coding-agent/test/edit/foo.test.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("test:packages/coding-agent/test/edit/foo.test.ts");
		// No broad package-wide test, and no other coding-agent test file.
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).not.toContain("test:packages/coding-agent/test/edit/bar.test.ts");
		const testTask = tasks.find(task => task.key === "test:packages/coding-agent/test/edit/foo.test.ts");
		expect(testTask?.command).toEqual(["bun", "test", "packages/coding-agent/test/edit/foo.test.ts"]);
	});

	test("SDK host and coordinator prompt-control changes include only coding-agent shard 1", () => {
		const shardOne = "test:@gajae-code/coding-agent:shard-1-of-8";
		for (const changedPath of [
			"packages/coding-agent/src/sdk/bus/index.ts",
			"packages/coding-agent/src/sdk/host/reverse-leases.ts",
			"packages/coding-agent/src/coordinator-mcp/server.ts",
			"packages/coding-agent/test/sdk-host-wiring.test.ts",
			"packages/coding-agent/test/coordinator-mcp/send-prompt-concurrency.test.ts",
		]) {
			const tasks = targeted([changedPath]);
			const keys = tasks.map(task => task.key);
			expect(keys).toContain(shardOne);
			expect(tasks.find(task => task.key === shardOne)?.command).toEqual(["bun", "test", "--shard=1/8"]);
			expect(keys.filter(key => key.startsWith("test:@gajae-code/coding-agent:shard-"))).toEqual([shardOne]);
		}
	});

	test("basename collisions fall back to package checks instead of arbitrary tests", () => {
		const tasks = targeted(["packages/coding-agent/src/sdk/bus/index.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("check:@gajae-code/coding-agent");
		expect(keys).toContain("test:@gajae-code/coding-agent:shard-1-of-8");
		expect(keys).not.toContain("test:packages/coding-agent/test/sdk/index.test.ts");
		expect(keys).not.toContain("test:packages/coding-agent/test/other/index.test.ts");
		expect(describeTasks(tasks).find(entry => entry.key === "check:@gajae-code/coding-agent")).toMatchObject({
			native: true,
			nativeBuild: false,
		});
	});

test("tab-worker graph changes always include install-methods and are Darwin relevant", () => {
		for (const changedPath of [
			"packages/coding-agent/src/tools/browser/tab-worker-entry.ts",
			"packages/coding-agent/src/tools/browser/new-worker-helper.ts",
			"packages/coding-agent/src/tools/browser/launch.ts",
			"packages/coding-agent/src/tools/browser/readable.ts",
			"packages/coding-agent/src/tools/browser/screenshot-format.ts",
			"packages/coding-agent/src/eval/js/shared/runtime.ts",
			"packages/coding-agent/src/eval/js/new-eval-helper.ts",
			"packages/coding-agent/src/web/scrapers/html-to-markdown.ts",
			"packages/coding-agent/src/web/scrapers/new-scraper-helper.ts",
			"packages/coding-agent/src/utils/linkedom.ts",
			"packages/coding-agent/src/utils/new-browser-safe-helper.ts",
			"packages/utils/src/new-worker-safe-helper.ts",
			"packages/coding-agent/src/tools/tool-errors.ts",
			"packages/coding-agent/src/tools/path-utils.ts",
			"packages/coding-agent/src/cli.ts",
			"packages/coding-agent/scripts/compile-args.ts",
			"packages/coding-agent/scripts/build-binary.ts",
			"packages/natives/native/index.js",
			"scripts/ci-build-native.ts",
			"packages/coding-agent/src/tools/puppeteer/00_stealth_tampering.txt",
			"packages/coding-agent/src/tools/puppeteer/15_stealth_webrtc.txt",
		]) {
			expect(isDarwinArm64TabWorkerSmokePath(changedPath)).toBe(true);
			expect(needsDarwinArm64TabWorkerSmoke([changedPath])).toBe(true);
			expect(targeted([changedPath]).map(task => task.key)).toContain("install-methods");
			expect(planTasks([changedPath], targetingPackages).map(task => task.key)).toContain("install-methods");
		}
	});

	test("irrelevant changes skip the Darwin smoke and install-methods", () => {
		const paths = ["packages/coding-agent/src/edit/foo.ts"];
		expect(needsDarwinArm64TabWorkerSmoke(paths)).toBe(false);
		expect(targeted(paths).map(task => task.key)).not.toContain("install-methods");
		expect(planTasks(paths, targetingPackages).map(task => task.key)).not.toContain("install-methods");
	});

	test("routes the Windows session-path regression for session I/O sources and its regression test", () => {
		for (const changedPath of [
			"packages/coding-agent/src/session/internal/managed-session-scope.ts",
			"packages/coding-agent/src/session/blob-store.ts",
			"packages/coding-agent/src/session/session-manager.ts",
			"packages/coding-agent/test/session-manager/windows-canonical-path.test.ts",
		]) {
			expect(isWindowsSessionPathRegressionPath(changedPath)).toBe(true);
			expect(needsWindowsSessionPathRegression([changedPath])).toBe(true);
		}
		expect(isWindowsSessionPathRegressionPath("packages/coding-agent/src/session/session-store.ts")).toBe(false);
		expect(needsWindowsSessionPathRegression(["packages/coding-agent/src/edit/foo.ts"])).toBe(false);
	});

	test("a deleted test path is not scheduled as a runnable test shard", () => {
		const tasks = targeted(["packages/coding-agent/test/edit/deleted.test.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).not.toContain("test:packages/coding-agent/test/edit/deleted.test.ts");
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).toContain("check:@gajae-code/coding-agent");
		expect(keys).toContain("cli-smoke");
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual(["native-linux-x64"]);
	});

	test("the live RLM e2e test gets native artifacts for skipped import-time setup", () => {
		const tasks = targeted(["packages/coding-agent/test/rlm-live-model-e2e.test.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("test:packages/coding-agent/test/rlm-live-model-e2e.test.ts");
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual(["native-linux-x64"]);
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).not.toContain("check:@gajae-code/coding-agent");

		const entries = describeTasks(tasks);
		const liveShard = entries.find(entry => entry.key === "test:packages/coding-agent/test/rlm-live-model-e2e.test.ts");
		expect(liveShard).toEqual({
			key: "test:packages/coding-agent/test/rlm-live-model-e2e.test.ts",
			identity: "legacy:dGVzdDpwYWNrYWdlcy9jb2RpbmctYWdlbnQvdGVzdC9ybG0tbGl2ZS1tb2RlbC1lMmUudGVzdC50cw:Lg",
			description: "Test packages/coding-agent/test/rlm-live-model-e2e.test.ts",
			command: ["bun", "test", "packages/coding-agent/test/rlm-live-model-e2e.test.ts"],
			cwd: undefined,
			native: true,
			rust: false,
			nextest: false,
			nativeBuild: false,
		});
		expect(entries.find(entry => entry.key === "native-linux-x64")?.nativeBuild).toBe(true);
	});

	test("a source file with a directly-named test maps exclusively to that test", () => {
		const tasks = targeted(["packages/coding-agent/src/edit/foo.ts"]);
		expect(tasks.map(task => task.key)).toEqual([
			"test:packages/coding-agent/test/edit/foo.test.ts",
			"native-linux-x64",
		]);
	});

	test("a source file with no mapped test runs the owning package check, not its test suite", () => {
		const tasks = targeted(["packages/coding-agent/src/edit/unmapped.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("check:@gajae-code/coding-agent");
		expect(keys).toContain("cli-smoke"); // coding-agent runtime smoke
		expect(keys.some(key => key.startsWith("test:"))).toBe(false);
	});

	test("main entrypoint adds its behavioral contract test without replacing owner fallback coverage", () => {
		const tasks = targeted(["packages/coding-agent/src/main.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toEqual([
			"test:packages/coding-agent/test/startup-update-contract.test.ts",
			"check:@gajae-code/coding-agent",
			"cli-smoke",
			"native-linux-x64",
		]);
		expect(tasks[0]?.command).toEqual(["bun", "test", "packages/coding-agent/test/startup-update-contract.test.ts"]);
		expect(tasks[1]).toMatchObject({
			command: ["bun", "run", "check"],
			cwd: resolvePackageCwd("packages/coding-agent"),
		});
		expect(tasks[2]?.command).toEqual(["bun", "run", "ci:test:smoke"]);
		expect(keys.filter(key => key === "native-linux-x64")).toHaveLength(1);
	});
	test("cache-eval evidence artifact adds its focused AI test without bypassing root fallback coverage", () => {
		const tasks = targeted(["artifacts/architecture-2383-eval.json"]);
		expect(tasks.map(task => task.key)).toEqual([
			"test:packages/ai/test/anthropic-cache-eval.integration.test.ts",
			"root-check",
			"native-linux-x64",
		]);
		expect(tasks[0]?.command).toEqual(["bun", "test", "packages/ai/test/anthropic-cache-eval.integration.test.ts"]);
		expect(tasks[1]?.command).toEqual(["bun", "run", "ci:check:full"]);
		expect(tasks[2]?.command).toEqual(["bash", "-lc", 'TARGET_VARIANTS="baseline modern" bun scripts/ci-build-native.ts']);
	});

	test("a CI workflow change plans yaml-parse + ci-selftest + ci-dry-run only", () => {
		const tasks = targeted([".github/workflows/dev-ci.yml"]);
		expect(tasks.map(task => task.key).sort()).toEqual(["ci-dry-run", "ci-selftest", "yaml-parse"]);
	});

	test("a CI harness script change plans ci-selftest + ci-dry-run (no yaml-parse)", () => {
		const tasks = targeted(["scripts/ci-dev-affected.ts"]);
		expect(tasks.map(task => task.key).sort()).toEqual(["ci-dry-run", "ci-selftest"]);
	});

	test("the dev CI guard topology test is scheduled and executed as a CI harness change", () => {
		const tasks = targeted(["scripts/dev-ci-guard-topology.test.ts"]);
		expect(tasks.map(task => task.key).sort()).toEqual(["ci-dry-run", "ci-selftest"]);
		expect(tasks.find(task => task.key === "ci-selftest")?.command).toEqual([
			"bun",
			"test",
			"scripts/ci-dev-affected.test.ts",
			"scripts/dev-ci-guard-topology.test.ts",
		]);
	});

	test("native platform package changes plan release publish validation", () => {
		const tasks = targeted(["packages/natives-linux-x64/package.json"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("release-publish-contract");
		expect(keys).toContain("release-publish-dry-run");
	});

	test("bridge-client changes retain package validation alongside release publish coverage", () => {
		const tasks = targeted(["packages/bridge-client/src/client.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys.filter(key => key === "check:@gajae-code/bridge-client")).toHaveLength(1);
		expect(keys.filter(key => key === "release-publish-contract")).toHaveLength(1);
		expect(keys.filter(key => key === "release-publish-dry-run")).toHaveLength(1);
		expect(keys.filter(key => key === "test:scripts/release-evidence.test.ts")).toHaveLength(1);
		expect(keys.filter(key => key === "bridge-client-sdk-package-smoke")).toHaveLength(1);
		expect(keys.filter(key => key === "test:packages/bridge-client/test/client.test.ts")).toHaveLength(1);
		expect(tasks.find(task => task.key === "bridge-client-sdk-package-smoke")?.command).toEqual([
			"bun",
			"packages/coding-agent/scripts/build-sdk-package-smoke.ts",
		]);
		expect(describeTasks(tasks).find(task => task.key === "bridge-client-sdk-package-smoke")?.native).toBe(true);
		expect(keys.filter(key => key === "native-linux-x64")).toHaveLength(1);
	});

	test("release evidence source changes select contract, dry-run, and focused evidence coverage once", () => {
		const tasks = targeted(["scripts/release-evidence.ts", "scripts/ci-release-publish.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys.filter(key => key === "release-publish-contract")).toHaveLength(1);
		expect(keys.filter(key => key === "release-publish-dry-run")).toHaveLength(1);
		expect(keys.filter(key => key === "test:scripts/release-evidence.test.ts")).toHaveLength(1);
		expect(tasks.find(task => task.key === "test:scripts/release-evidence.test.ts")?.command).toEqual(["bun", "test", "scripts/release-evidence.test.ts"]);
	});

	test("unscoped wrapper package changes keep wrapper-version smoke with release validation", () => {
		const tasks = targeted(["packages/gajae-code/bin/gjc.js"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("release-publish-contract");
		expect(keys).toContain("release-publish-dry-run");
		expect(keys).toContain("wrapper-version");
	});

	test("root-level codeish fallback plans the native artifact required by the bounded check", () => {
		const tasks = targeted(["scripts/unmapped-tool.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("root-check");
		expect(keys).toContain("native-linux-x64");

		const rootCheck = describeTasks(tasks).find(entry => entry.key === "root-check");
		expect(rootCheck).toMatchObject({ command: ["bun", "run", "ci:check:full"], native: true, nativeBuild: false });
	});

	test("docs/changelog-only changes plan nothing expensive", () => {
		expect(targeted(["docs/guide.md", "CHANGELOG.md", "packages/coding-agent/README.md"])).toEqual([]);
	});

test("Python SDK changes plan dedicated Python validation and one native build", () => {
	const changed = ["python/gjc-sdk/gjc_sdk/client.py"];
	for (const tasks of [planTasks(changed, packages), planTargetedTasks(changed, packages, [])]) {
		expect(tasks.map(task => task.key)).toEqual(["python-check", "python-test", "python-build-smoke", "native-linux-x64"]);
		expect(tasks.filter(task => task.phase === "python").map(task => task.key)).toEqual(["python-check", "python-test", "python-build-smoke"]);
	}
	const full = planFullTasks(packages);
	expect(full.filter(task => task.phase === "python").map(task => task.key)).toEqual(["python-check", "python-test", "python-build-smoke"]);
});


	test("native-consuming test files pull in a single native build task", () => {
		const tasks = targeted(["packages/coding-agent/test/cli.test.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("test:packages/coding-agent/test/cli.test.ts");
		// ensureNativeBuild adds exactly one native build task (built once, shared).
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual(["native-linux-x64"]);

		const entries = describeTasks(tasks);
		const cliShard = entries.find(entry => entry.key === "test:packages/coding-agent/test/cli.test.ts");
		expect(cliShard?.native).toBe(true);
	});
});

describe("push-mode broad planning still runs the fuller suite", () => {
	const codingAgent: WorkspacePackage = {
		name: "@gajae-code/coding-agent",
		dir: "packages/coding-agent",
		manifest: { name: "@gajae-code/coding-agent", scripts: { check: "biome check .", test: "bun test" } },
	};

	const bridgeClient: WorkspacePackage = {
		name: "@gajae-code/bridge-client",
		dir: "packages/bridge-client",
		manifest: { name: "@gajae-code/bridge-client", scripts: { check: "biome check .", test: "bun test" } },
	};
	test("push mode splits the package-wide coding-agent test across bounded shards", () => {
		const tasks = planTasks(["packages/coding-agent/src/edit/foo.ts"], [codingAgent]);
		const keys = tasks.map(task => task.key);
		const testShards = tasks.filter(task => task.key.startsWith("test:@gajae-code/coding-agent:shard-"));
		// Broad planner keeps the post-merge fuller suite, but not as one 30m shard.
		expect(testShards.map(task => task.key)).toEqual([
			"test:@gajae-code/coding-agent:shard-1-of-8",
			"test:@gajae-code/coding-agent:shard-2-of-8",
			"test:@gajae-code/coding-agent:shard-3-of-8",
			"test:@gajae-code/coding-agent:shard-4-of-8",
			"test:@gajae-code/coding-agent:shard-5-of-8",
			"test:@gajae-code/coding-agent:shard-6-of-8",
			"test:@gajae-code/coding-agent:shard-7-of-8",
			"test:@gajae-code/coding-agent:shard-8-of-8",
		]);
		expect(testShards[0]?.command).toEqual(["bun", "test", "--shard=1/8"]);
		expect(testShards[0]?.cwd).toBe(resolvePackageCwd("packages/coding-agent"));
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).toContain("check:@gajae-code/coding-agent");

		const entries = describeTasks(tasks);
		expect(entries.find(entry => entry.key === "test:@gajae-code/coding-agent:shard-1-of-8")?.native).toBe(true);
	});

	test("push mode schedules release evidence contract, dry-run, and focused coverage once", () => {
		const tasks = planTasks(["scripts/release-evidence.ts", "scripts/ci-release-publish.ts"], [codingAgent]);
		const keys = tasks.map(task => task.key);
		expect(keys.filter(key => key === "release-publish-contract")).toHaveLength(1);
		expect(keys.filter(key => key === "release-publish-dry-run")).toHaveLength(1);
		expect(keys.filter(key => key === "test:scripts/release-evidence.test.ts")).toHaveLength(1);
		expect(tasks.find(task => task.key === "test:scripts/release-evidence.test.ts")?.command).toEqual(["bun", "test", "scripts/release-evidence.test.ts"]);
	});

	test("tooling-script root-check marks the bounded check as a native consumer", () => {
		const tasks = planTasks(["scripts/unmapped-tool.ts"], [codingAgent]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("root-check");
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual([]);

		const rootCheck = describeTasks(tasks).find(entry => entry.key === "root-check");
		expect(rootCheck).toMatchObject({ command: ["bun", "run", "ci:check:full"], native: true, nativeBuild: false });
	});

	test("push mode selects the bridge-client SDK package smoke exactly once for package and SDK client changes", () => {
		const tasks = planTasks(
			["packages/bridge-client/package.json", "packages/coding-agent/src/sdk/client/client.ts"],
			[codingAgent, bridgeClient],
		);
		const keys = tasks.map(task => task.key);
		expect(keys.filter(key => key === "bridge-client-sdk-package-smoke")).toHaveLength(1);
		expect(tasks.find(task => task.key === "bridge-client-sdk-package-smoke")?.command).toEqual([
			"bun",
			"packages/coding-agent/scripts/build-sdk-package-smoke.ts",
		]);
		expect(describeTasks(tasks).find(task => task.key === "bridge-client-sdk-package-smoke")?.native).toBe(true);
		expect(keys.filter(key => key === "native-linux-x64")).toHaveLength(1);
		expect(keys.filter(key => key === "release-publish-contract")).toHaveLength(1);
		expect(keys.filter(key => key === "release-publish-dry-run")).toHaveLength(1);
	});

	test("full-workspace changes partition root tests into matrix shards", () => {
		const tasks = planTasks(["tsconfig.json"], [codingAgent]);
		const keys = tasks.map(task => task.key);

		expect(keys).toContain("root-check");
		expect(keys).toContain("root-test:release");
		expect(keys).not.toContain("root-test");
		expect(tasks.filter(task => task.key.startsWith("test:@gajae-code/coding-agent:shard-")).map(task => task.key)).toEqual([
			"test:@gajae-code/coding-agent:shard-1-of-8",
			"test:@gajae-code/coding-agent:shard-2-of-8",
			"test:@gajae-code/coding-agent:shard-3-of-8",
			"test:@gajae-code/coding-agent:shard-4-of-8",
			"test:@gajae-code/coding-agent:shard-5-of-8",
			"test:@gajae-code/coding-agent:shard-6-of-8",
			"test:@gajae-code/coding-agent:shard-7-of-8",
			"test:@gajae-code/coding-agent:shard-8-of-8",
		]);
	});
});

describe("normalizeChangedPaths", () => {
	test("normalizes, deduplicates, and orders safe repository-relative paths", () => {
		expect(normalizeChangedPaths(["packages\\stats/src/index.ts", "./packages/stats/src/index.ts"])).toEqual(["packages/stats/src/index.ts"]);
	});

	test("rejects absolute and escaping paths", () => {
		for (const unsafe of ["/etc/passwd", "../package.json", "packages/../package.json", "C:/workspace/package.json"]) {
			expect(() => normalizeChangedPaths([unsafe])).toThrow("affected-path-invalid");
		}
	});
});

describe("build inventory validation", () => {
	test("rejects unknown fields and duplicate Cargo names without the typed emergency", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-inventory-"));
		try {
			const source = JSON.parse(await Bun.file(path.join(import.meta.dir, "ci-dev-affected-build-inventory.json")).text()) as {
				schemaVersion: number;
				typescript: Array<Record<string, unknown>>;
				cargo: Array<Record<string, unknown>>;
				emergency: Record<string, unknown>;
			};
			const unknownPath = path.join(root, "unknown.json");
			await Bun.write(unknownPath, JSON.stringify({ ...source, unexpected: true }));
			await expect(loadBuildInventory(unknownPath)).rejects.toThrow("unexpected build inventory field");

			const duplicatePath = path.join(root, "duplicate.json");
			const duplicateCargo = source.cargo.map((unit, index) => index === 1 ? { ...unit, name: source.cargo[0]?.name } : unit);
			await Bun.write(duplicatePath, JSON.stringify({ ...source, cargo: duplicateCargo, emergency: {} }));
			await expect(loadBuildInventory(duplicatePath)).rejects.toThrow("duplicate Cargo names require workspace emergency");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("workspace dependent closure", () => {
	const leaf: WorkspacePackage = { name: "leaf", dir: "packages/leaf", manifest: { name: "leaf", dependencies: { top: "workspace:*" } } };
	const middle: WorkspacePackage = { name: "middle", dir: "packages/middle", manifest: { name: "middle", dependencies: { leaf: "workspace:*" } } };
	const top: WorkspacePackage = { name: "top", dir: "packages/top", manifest: { name: "top", dependencies: { middle: "workspace:*" } } };
	const graph = [leaf, middle, top];

	test("selects direct and transitive dependents through a cycle without duplicates", () => {
		expect(expandWithDependents([leaf], graph).map(unit => unit.name)).toEqual(["leaf", "middle", "top"]);
		expect(expandWithDependents([middle], graph).map(unit => unit.name)).toEqual(["leaf", "middle", "top"]);
	});
});

describe("Cargo workspace ambiguity", () => {
	const first: CargoInventoryUnit = { id: "first", name: "duplicate", manifestPath: "crates/first/Cargo.toml", supported: true, nativeAddonSource: false };
	const second: CargoInventoryUnit = { id: "second", name: "duplicate", manifestPath: "crates/second/Cargo.toml", supported: true, nativeAddonSource: false };
	const unique: CargoInventoryUnit = { id: "unique", name: "unique", manifestPath: "crates/unique/Cargo.toml", supported: true, nativeAddonSource: false };
	const supported = [first, second, unique];

	test("uses the workspace emergency when any selected name is globally duplicated", () => {
		expect(requiresCargoWorkspaceEmergency([first], supported)).toBe(true);
		expect(requiresCargoWorkspaceEmergency([first, second], supported)).toBe(true);
		expect(requiresCargoWorkspaceEmergency([unique], supported)).toBe(false);
	});
});

describe("planFullTasks — Main CI full mode (issue: shard main CI)", () => {
	const fullModePackages: WorkspacePackage[] = [
		{
			name: "@gajae-code/coding-agent",
			dir: "packages/coding-agent",
			manifest: { name: "@gajae-code/coding-agent", scripts: { test: "true" } },
		},
		{
			name: "@gajae-code/example",
			dir: "packages/example",
			manifest: { name: "@gajae-code/example", scripts: { check: "true", test: "true" } },
		},
	];

	function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
		const previous = new Map<string, string | undefined>();
		for (const [key, value] of Object.entries(env)) {
			previous.set(key, process.env[key]);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		try {
			return run();
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	test("default env emits the complete task union and omits root-check", () => {
		const keys = withEnv(
			{ CI_CODING_AGENT_TEST_SHARDS: undefined, CI_RUST_TEST_PARTITIONS: undefined },
			() => planFullTasks(fullModePackages).map(task => task.key),
		);
		// root-check is covered by the dedicated native-free `check` job.
		expect(keys).not.toContain("root-check");
		expect(keys).toContain("native-linux-x64");
		expect(keys).toContain("root-test:release");
		expect(keys).toContain("rust-check");
		expect(keys).toContain("cli-smoke");
		expect(keys).toContain("runtime-check");
		expect(keys).toContain("test:@gajae-code/example");
		// Default coding-agent shard count stays 8 (dev parity).
		expect(keys.filter(key => key.startsWith("test:@gajae-code/coding-agent:shard-")).length).toBe(8);
		expect(keys).toContain("test:@gajae-code/coding-agent:shard-1-of-8");
		// Default rust-test stays a single unpartitioned task.
		expect(keys).toContain("rust-test");
		expect(keys.some(key => key.startsWith("rust-test:partition-"))).toBe(false);
	});

	test("no full-mode task uses the false-green standalone `bun --cwd` form (issue #622)", () => {
		const tasks = withEnv({ CI_CODING_AGENT_TEST_SHARDS: "16", CI_RUST_TEST_PARTITIONS: "4" }, () =>
			planFullTasks(fullModePackages),
		);
		for (const task of tasks) {
			expect(task.command.some(arg => arg.startsWith("--cwd"))).toBe(false);
		}
		const runtimeCheck = tasks.find(task => task.key === "runtime-check");
		expect(runtimeCheck?.command).toEqual(["bun", "run", "check:runtime"]);
		expect(runtimeCheck?.cwd).toBe(resolvePackageCwd("packages/coding-agent"));
	});

	test("CI_CODING_AGENT_TEST_SHARDS overrides the coding-agent shard count", () => {
		const keys = withEnv({ CI_CODING_AGENT_TEST_SHARDS: "16" }, () =>
			planFullTasks(fullModePackages).map(task => task.key),
		);
		const shards = keys.filter(key => key.startsWith("test:@gajae-code/coding-agent:shard-"));
		expect(shards.length).toBe(16);
		expect(shards).toContain("test:@gajae-code/coding-agent:shard-1-of-16");
		expect(shards).toContain("test:@gajae-code/coding-agent:shard-16-of-16");
	});

	test("CI_RUST_TEST_PARTITIONS splits rust-test into nextest partitions", () => {
		const tasks = withEnv({ CI_RUST_TEST_PARTITIONS: "4" }, () => planFullTasks(fullModePackages));
		const partitions = tasks.filter(task => task.key.startsWith("rust-test:partition-"));
		expect(partitions.length).toBe(4);
		expect(tasks.some(task => task.key === "rust-test")).toBe(false);
		expect(partitions[0]?.command).toEqual(["bun", "scripts/run-rs-task.ts", "test:rs", "count:1/4"]);
		expect(partitions[3]?.command).toEqual(["bun", "scripts/run-rs-task.ts", "test:rs", "count:4/4"]);
		const described = describeTasks(partitions);
		for (const entry of described) {
			expect(entry.rust).toBe(true);
			expect(entry.nextest).toBe(true);
			expect(entry.native).toBe(false);
		}
	});

	test("invalid env values fall back to safe defaults", () => {
		const keys = withEnv(
			{ CI_CODING_AGENT_TEST_SHARDS: "0", CI_RUST_TEST_PARTITIONS: "abc" },
			() => planFullTasks(fullModePackages).map(task => task.key),
		);
		expect(keys.filter(key => key.startsWith("test:@gajae-code/coding-agent:shard-")).length).toBe(8);
		expect(keys).toContain("rust-test");
		expect(keys.some(key => key.startsWith("rust-test:partition-"))).toBe(false);
	});

	test("the native build task is the only nativeBuild entry and runtime consumers download it", () => {
		const entries = withEnv({ CI_CODING_AGENT_TEST_SHARDS: "16", CI_RUST_TEST_PARTITIONS: "4" }, () =>
			describeTasks(planFullTasks(fullModePackages)),
		);
		expect(entries.filter(entry => entry.nativeBuild).map(entry => entry.key)).toEqual(["native-linux-x64"]);
		expect(entries.find(entry => entry.key === "cli-smoke")?.native).toBe(true);
		expect(entries.find(entry => entry.key === "runtime-check")?.native).toBe(true);
		expect(entries.find(entry => entry.key === "test:@gajae-code/coding-agent:shard-1-of-16")?.native).toBe(true);
	});
});
