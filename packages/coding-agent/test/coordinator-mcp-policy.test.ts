import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertCoordinatorArtifactPath,
	assertCoordinatorWorkdir,
	buildCoordinatorMcpConfig,
	requireCoordinatorMutation,
} from "../src/coordinator-mcp/policy";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-policy-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Hermes MCP safety policy", () => {
	it("defaults to read-only with a deterministic local state root when no session env exists", () => {
		const config = buildCoordinatorMcpConfig({});

		expect(config.stateRoot).toBe(path.join(process.cwd(), ".gjc", "state", "coordinator-mcp"));
		expect(config.mutationClasses.size).toBe(0);
		expect(config.namespace.profile).toBeNull();
		expect(config.namespace.repo).toBeNull();
		expect(config.artifactByteCap).toBe(65536);
	});

	it("scopes the default state root to GJC_SESSION_ID when present", () => {
		const config = buildCoordinatorMcpConfig({ GJC_SESSION_ID: "coordinator-policy-test-session" });

		expect(config.stateRoot).toContain(
			path.join(".gjc", "_session-coordinator-policy-test-session", "state", "coordinator-mcp"),
		);
		expect(config.mutationClasses.size).toBe(0);
		expect(config.namespace.profile).toBeNull();
		expect(config.namespace.repo).toBeNull();
		expect(config.artifactByteCap).toBe(65536);
	});

	it("requires startup mutation opt-in and per-call allow_mutation", () => {
		const config = buildCoordinatorMcpConfig({
			GJC_SESSION_ID: "coordinator-policy-test-session",
			GJC_COORDINATOR_MCP_MUTATIONS: "sessions,reports",
		});

		expect(() => requireCoordinatorMutation(config, "sessions", { allow_mutation: false })).toThrow(
			"coordinator_mutation_call_not_allowed",
		);
		expect(() => requireCoordinatorMutation(config, "questions", { allow_mutation: true })).toThrow(
			"coordinator_mutation_class_disabled:questions",
		);
		expect(() => requireCoordinatorMutation(config, "sessions", { allow_mutation: true })).not.toThrow();
	});

	it("rejects workdirs outside canonical allowlisted roots", async () => {
		const root = await tempRoot();
		const outside = await tempRoot();
		const config = buildCoordinatorMcpConfig({
			GJC_SESSION_ID: "coordinator-policy-test-session",
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
		});

		await expect(assertCoordinatorWorkdir(config, path.join(root, "child"))).resolves.toBe(path.join(root, "child"));
		await expect(assertCoordinatorWorkdir(config, outside)).rejects.toThrow(
			"coordinator_workdir_outside_allowed_roots",
		);
		await expect(assertCoordinatorWorkdir(config, path.join(root, "..", path.basename(outside)))).rejects.toThrow(
			"coordinator_workdir_outside_allowed_roots",
		);
	});

	it("rejects artifact symlink escapes and enforces byte caps", async () => {
		const root = await tempRoot();
		const outside = await tempRoot();
		const safeFile = path.join(root, "artifact.txt");
		const escapedLink = path.join(root, "escaped.txt");
		await Bun.write(safeFile, "abcdef");
		await Bun.write(path.join(outside, "secret.txt"), "secret");
		await fs.symlink(path.join(outside, "secret.txt"), escapedLink);
		const config = buildCoordinatorMcpConfig({
			GJC_SESSION_ID: "coordinator-policy-test-session",
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP: "3",
		});

		const safe = await assertCoordinatorArtifactPath(config, safeFile);
		expect(safe.path).toBe(safeFile);
		expect(safe.byteCap).toBe(3);
		await expect(assertCoordinatorArtifactPath(config, escapedLink)).rejects.toThrow(
			"coordinator_artifact_outside_allowed_roots",
		);
	});

	it("denies an artifact after its parent directory is swapped for an outside symlink", async () => {
		const root = await tempRoot();
		const outside = await tempRoot();
		const parent = path.join(root, "artifacts");
		await fs.mkdir(parent);
		await Bun.write(path.join(outside, "secret.txt"), "secret");
		await fs.rm(parent, { recursive: true });
		await fs.symlink(outside, parent);
		const config = buildCoordinatorMcpConfig({
			GJC_SESSION_ID: "coordinator-policy-test-session",
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
		});
		await expect(assertCoordinatorArtifactPath(config, path.join(parent, "secret.txt"))).rejects.toThrow(
			"coordinator_artifact_outside_allowed_roots",
		);
	});
});
