import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const bunConfig = path.resolve(import.meta.dir, "../src/sdk/broker/internal-source.bunfig.toml");
const fixtures: string[] = [];

async function fixture(): Promise<{ root: string; project: string; profile: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-doctor-readonly-"));
	fixtures.push(root);
	const project = path.join(root, "project");
	const profile = path.join(root, "profile");
	await fs.mkdir(project);
	await fs.mkdir(profile);
	return { root, project, profile };
}

async function snapshot(root: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	async function visit(directory: string): Promise<void> {
		for (const name of (await fs.readdir(directory)).sort()) {
			const file = path.join(directory, name);
			const stat = await fs.lstat(file);
			const relative = path.relative(root, file);
			if (stat.isSymbolicLink()) result[relative] = `link:${await fs.readlink(file)}`;
			else if (stat.isDirectory()) {
				result[relative] = `directory:${stat.mode}`;
				await visit(file);
			} else {
				const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex");
				result[relative] = `file:${stat.mode}:${stat.mtimeMs}:${digest}`;
			}
		}
	}
	await visit(root);
	return result;
}

async function invoke(
	directories: { root: string; project: string; profile: string; path?: string },
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${bunConfig}`, cli, "doctor", ...args], {
		cwd: directories.project,
		env: {
			// Tests that depend on what is discoverable on PATH pin it explicitly, so a
			// developer machine's dev-linked aliases cannot decide the result.
			PATH: directories.path ?? process.env.PATH,
			HOME: directories.root,
			GJC_CODING_AGENT_DIR: directories.profile,
			NO_COLOR: "1",
			// Isolate product writes from Bun's source-transpilation cache, created before entrypoint code runs.
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exitCode };
	} finally {
		clearTimeout(timer);
	}
}

afterEach(async () => {
	for (const root of fixtures.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("doctor read-only CLI", () => {
	it("discovers canonical service slots without exposing tokens or acquiring ownership", async () => {
		const directories = await fixture();
		const sdk = path.join(directories.profile, "sdk");
		await fs.mkdir(path.join(sdk, "broker.lock"), { recursive: true, mode: 0o700 });
		await Bun.write(
			path.join(sdk, "broker.json"),
			JSON.stringify({ ownerId: "private-owner-sentinel", token: "private-token-sentinel" }),
		);
		await Bun.write(
			path.join(sdk, "broker.lock", "owner.json"),
			JSON.stringify({ ownerId: "private-owner-sentinel", version: 1 }),
		);
		const before = await snapshot(directories.root);
		const result = await invoke(directories, ["--json", "--check", "service"]);
		const report = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(report.summary.exitCode);
		expect(
			report.checks.some(
				(check: { targetId: string; evidence: { present?: boolean } }) =>
					check.targetId.endsWith(":broker:owner-lock") && check.evidence.present === true,
			),
		).toBe(true);
		expect(result.stdout + result.stderr).not.toContain("private-owner-sentinel");
		expect(result.stdout + result.stderr).not.toContain("private-token-sentinel");
		expect(await snapshot(directories.root)).toEqual(before);
	});

	it("refuses service namespace symlinks rather than following them", async () => {
		const directories = await fixture();
		const outside = path.join(directories.root, "outside");
		await fs.mkdir(outside);
		await Bun.write(path.join(outside, "broker.json"), '{"token":"outside-secret"}');
		await fs.symlink(outside, path.join(directories.profile, "sdk"));
		const before = await snapshot(directories.root);
		const result = await invoke(directories, ["--json", "--check", "service.broker.discovery"]);
		const report = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(3);
		expect(report.checks.find((check: { id: string }) => check.id === "service.broker.discovery")).toMatchObject({
			execution: "blocked",
			reasonCode: "service_artifact_symlink",
		});
		expect(result.stdout + result.stderr).not.toContain("outside-secret");
		expect(await snapshot(directories.root)).toEqual(before);
	});

	it("returns a redacted JSON usage envelope without product writes", async () => {
		const directories = await fixture();
		const before = await snapshot(directories.root);
		const result = await invoke(directories, ["--json", "--allow-risk", "private-secret-sentinel"]);
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout).summary.exitCode).toBe(2);
		expect(result.stdout + result.stderr).not.toContain("private-secret-sentinel");
		expect(await snapshot(directories.root)).toEqual(before);
	});

	it("does not treat --yes as risk authorization and keeps the matching preview inert", async () => {
		const directories = await fixture();
		const config = path.join(directories.profile, "config.yml");
		await Bun.write(config, "skills:\n  enabled: false\n");
		const diagnosis = await invoke(directories, ["--json", "--check", "config", "--scope", "user"]);
		const target = JSON.parse(diagnosis.stdout).checks[0].targetId as string;
		const before = await snapshot(directories.root);
		const args = [
			"--json",
			"--fix",
			"--repair",
			"config.set-validated",
			"--target",
			target,
			"--set-value-json",
			"true",
			"--yes",
			"--check",
			"config",
			"--scope",
			"user",
		];
		const blocked = await invoke(directories, args);
		const report = JSON.parse(blocked.stdout);
		expect(blocked.exitCode).toBe(3);
		expect(report.summary.exitCode).toBe(3);
		expect(report.repairs[0]).toMatchObject({ state: "blocked", sideEffectStarted: false });
		expect(report.repairs[0].readiness).toContain("authorization_missing");
		const unconfirmed = await invoke(directories, [
			...args.filter(arg => arg !== "--yes"),
			"--allow-risk",
			"config-change",
		]);
		expect(unconfirmed.exitCode).toBe(3);
		expect(JSON.parse(unconfirmed.stdout).repairs[0].readiness).toContain("confirmation_required");
		const preview = await invoke(directories, [...args, "--allow-risk", "config-change", "--dry-run"]);
		expect(preview.exitCode).toBe(0);
		expect(JSON.parse(preview.stdout).repairs[0].state).toBe("planned");
		expect(await snapshot(directories.root)).toEqual(before);
	});

	it("distinguishes an unknown MCP target from uninspectable target resolution", async () => {
		const directories = await fixture();
		const config = path.join(directories.profile, "mcp.json");
		await Bun.write(config, '{"mcpServers":{}}\n');
		const diagnosis = await invoke(directories, ["--json", "--check", "mcp", "--scope", "user"]);
		const rootId = (JSON.parse(diagnosis.stdout).checks[0].targetId as string).split(":")[2];
		const args = [
			"--json",
			"--dry-run",
			"--repair",
			"mcp.set-startup-policy",
			"--target",
			`t1:mcp:${rootId}:user:n${"0".repeat(64)}:enabled`,
			"--set-value-json",
			"false",
			"--check",
			"mcp",
			"--scope",
			"user",
		];
		const unknown = await invoke(directories, args);
		expect(unknown.exitCode).toBe(2);
		expect(JSON.parse(unknown.stdout).invocationError).toBe("unknown_target");
		await Bun.write(config, '{"mcpServers": INVALID}');
		const incomplete = await invoke(directories, args);
		expect(incomplete.exitCode).toBe(3);
		expect(JSON.parse(incomplete.stdout).repairs[0].readiness).toContain("target_resolution_incomplete");
	});

	it("runs fixed native and projection probes without product-state writes", async () => {
		const directories = await fixture();
		const before = await snapshot(directories.root);
		const result = await invoke(directories, ["--json"]);
		const report = JSON.parse(result.stdout);
		expect(report.summary.exitCode).toBe(result.exitCode);
		expect(report.checks.find((check: { id: string }) => check.id === "native.exports")).toMatchObject({
			execution: "completed",
			health: "ok",
			reasonCode: "native_exports_verified",
		});
		expect(report.checks.some((check: { id: string }) => check.id.startsWith("projection."))).toBe(true);
		expect(await snapshot(directories.root)).toEqual(before);
	});

	it("selects an exact check and rejects an unknown selector without reflecting it", async () => {
		const directories = await fixture();
		await Bun.write(path.join(directories.profile, "config.yml"), "skills:\n  enabled: false\n");
		const selected = await invoke(directories, ["--json", "--check", "config.user.skills.enabled"]);
		const report = JSON.parse(selected.stdout);
		expect(selected.exitCode).toBe(0);
		expect(report.checks.map((check: { id: string }) => check.id)).toEqual(["config.user.skills.enabled"]);
		const unknown = await invoke(directories, ["--json", "--check", "config.UNKNOWN_CHECK_SECRET"]);
		expect(unknown.exitCode).toBe(2);
		expect(JSON.parse(unknown.stdout).summary.exitCode).toBe(2);
		expect(unknown.stdout + unknown.stderr).not.toContain("UNKNOWN_CHECK_SECRET");
	});

	it("reports malformed settings without leaking parser snippets or changing the fixture", async () => {
		const directories = await fixture();
		const secret = "DOCTOR_SECRET_SENTINEL_93ef";
		await Bun.write(path.join(directories.profile, "config.yml"), `skills: [\n  token: ${secret}\n`);
		const before = await snapshot(directories.root);
		const result = await invoke(directories, ["--json", "--check", "runtime", "--check", "config"]);
		const report = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(1);
		expect(report.summary.exitCode).toBe(result.exitCode);
		expect(report.checks.some((check: { id: string }) => check.id === "runtime.identity")).toBe(true);
		expect(
			report.checks.filter((check: { reasonCode: string }) => check.reasonCode === "config_parse_error").length,
		).toBeGreaterThan(0);
		expect(result.stdout + result.stderr).not.toContain(secret);
		expect(await snapshot(directories.root)).toEqual(before);
	});

	it("reuses stable target IDs across read-only invocations without creating identity state", async () => {
		const directories = await fixture();
		await Bun.write(path.join(directories.profile, "config.yml"), "skills:\n  enabled: false\n");
		const before = await snapshot(directories.root);
		const first = await invoke(directories, ["--json", "--check", "config", "--scope", "user"]);
		const second = await invoke(directories, ["--json", "--check", "config", "--scope", "user"]);
		const a = JSON.parse(first.stdout);
		const b = JSON.parse(second.stdout);
		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		expect(a.checks.map((check: { targetId: string }) => check.targetId)).toEqual(
			b.checks.map((check: { targetId: string }) => check.targetId),
		);
		expect(a.checks[0].targetId).toMatch(/^t1:config:r[0-9a-f]{64}:user:skills\./);
		expect(await snapshot(directories.root)).toEqual(before);
	});

	it("keeps preview inert and reports MCP policy without connecting to its endpoint", async () => {
		const directories = await fixture();
		await Bun.write(
			path.join(directories.profile, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"server.with.dots": {
						type: "http",
						url: "http://127.0.0.1:1/private/DOCTOR_URL_SECRET",
						enabled: true,
					},
				},
				disabledServers: ["server.with.dots"],
			}),
		);
		const before = await snapshot(directories.root);
		const result = await invoke(directories, ["--json", "--dry-run", "--check", "mcp", "--scope", "user"]);
		const report = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(0);
		expect(report.summary.exitCode).toBe(0);
		expect(report.checks).toHaveLength(2);
		expect(
			report.checks.every(
				(check: { evidence: { startupStatus: string } }) => check.evidence.startupStatus === "disabled",
			),
		).toBe(true);
		expect(result.stdout + result.stderr).not.toContain("DOCTOR_URL_SECRET");
		expect(result.stdout + result.stderr).not.toContain("server.with.dots");
		expect(await snapshot(directories.root)).toEqual(before);
	});

	it("writes no product state while diagnosing a config that provokes a warning", async () => {
		const directories = await fixture();
		// An unrecognized field makes the shared settings loader warn, and the
		// logger's default sink is a rotating file under the agent directory. A
		// diagnose run must still not create it: purity has to hold for the config
		// that provokes a warning, not only for a pristine one.
		await Bun.write(path.join(directories.profile, "config.yml"), "model: test\n");
		const before = await snapshot(directories.root);
		const result = await invoke(directories, ["--json"]);
		const report = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(report.summary.exitCode);
		expect(await snapshot(directories.root)).toEqual(before);
	});

	it("exits 0 on a degraded verdict and reserves exit 1 for an error-health check", async () => {
		const directories = await fixture();
		// A world-readable config is a warning, not an error: the documented table
		// promises warnings alone stay exit 0, so a degraded run must not inflate to 1.
		await Bun.write(path.join(directories.profile, "config.yml"), "model: test\n");
		await fs.chmod(path.join(directories.profile, "config.yml"), 0o644);
		const result = await invoke(directories, ["--json", "--check", "permissions"]);
		const report = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(report.summary.exitCode);
		expect(report.summary.verdict).toBe("degraded");
		expect(report.summary.exitCode).toBe(0);
		expect(report.checks.some((check: { health: string }) => check.health === "warning")).toBe(true);
	});

	it("states managed-link inapplicability instead of silently omitting the check", async () => {
		const directories = await fixture();
		const before = await snapshot(directories.root);
		// A PATH with no alias on it is the from-scratch case. The group must still
		// answer: an empty result is indistinguishable from "nothing to say", which
		// is exactly the silent omission this check exists to prevent. Asserting
		// against the ambient PATH would pass only on a machine that ran `dev:link`.
		const result = await invoke({ ...directories, path: "/usr/bin:/bin" }, ["--json", "--check", "link"]);
		const report = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(report.summary.exitCode);
		// The group always reports something; an empty result would hide the scope.
		expect(report.checks.length).toBeGreaterThan(0);
		expect(report.checks.every((check: { id: string }) => check.id.includes("link"))).toBe(true);
		expect(report.checks.some((check: { reasonCode?: string }) => check.reasonCode === "managed_link_absent")).toBe(
			true,
		);
		// A known-inapplicable answer is completed, never counted as incomplete
		// coverage, which would otherwise force exit 3 on a healthy install.
		for (const check of report.checks as { execution: string; health: string }[])
			if (check.health === "not_applicable") expect(check.execution).toBe("completed");
		expect(report.coverage.unsupported).toBe(0);
		expect(report.coverage.blocked + report.coverage.timedOut).toBe(0);
		expect(await snapshot(directories.root)).toEqual(before);
	});

	it("rejects an informational target id as a repair target", async () => {
		const directories = await fixture();
		const before = await snapshot(directories.root);
		// The not-applicable link check publishes an id that is deliberately not a
		// valid target: it must never be addressable as something to repair.
		const result = await invoke(directories, [
			"--json",
			"--fix",
			"--repair",
			"install.repair-managed-link",
			"--target",
			"t1:link:r0:not-applicable",
			"--ref",
			"candidate",
			"--allow-risk",
			"install-replace",
			"--yes",
		]);
		const report = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(report.summary.exitCode);
		expect(report.summary.exitCode).toBe(2);
		expect(report.repairs ?? []).toHaveLength(0);
		expect(await snapshot(directories.root)).toEqual(before);
	});
});
