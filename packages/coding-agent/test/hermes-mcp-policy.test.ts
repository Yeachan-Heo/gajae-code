import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertHermesArtifactPath,
	assertHermesWorkdir,
	buildHermesMcpConfig,
	requireHermesMutation,
} from "../src/hermes-mcp/policy";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hermes-policy-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Hermes MCP safety policy", () => {
	it("defaults to read-only with no implicit global namespace", () => {
		const config = buildHermesMcpConfig({});

		expect(config.mutationClasses.size).toBe(0);
		expect(config.namespace.profile).toBeNull();
		expect(config.namespace.repo).toBeNull();
		expect(config.artifactByteCap).toBe(65536);
	});

	it("requires startup mutation opt-in and per-call allow_mutation", () => {
		const config = buildHermesMcpConfig({ GJC_HERMES_MCP_MUTATIONS: "sessions,reports" });

		expect(() => requireHermesMutation(config, "sessions", { allow_mutation: false })).toThrow(
			"hermes_mutation_call_not_allowed",
		);
		expect(() => requireHermesMutation(config, "questions", { allow_mutation: true })).toThrow(
			"hermes_mutation_class_disabled:questions",
		);
		expect(() => requireHermesMutation(config, "sessions", { allow_mutation: true })).not.toThrow();
	});

	it("rejects workdirs outside canonical allowlisted roots", async () => {
		const root = await tempRoot();
		const outside = await tempRoot();
		const config = buildHermesMcpConfig({ GJC_HERMES_MCP_WORKDIR_ROOTS: root });

		await expect(assertHermesWorkdir(config, path.join(root, "child"))).resolves.toBe(path.join(root, "child"));
		await expect(assertHermesWorkdir(config, outside)).rejects.toThrow("hermes_workdir_outside_allowed_roots");
		await expect(assertHermesWorkdir(config, path.join(root, "..", path.basename(outside)))).rejects.toThrow(
			"hermes_workdir_outside_allowed_roots",
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
		const config = buildHermesMcpConfig({
			GJC_HERMES_MCP_WORKDIR_ROOTS: root,
			GJC_HERMES_MCP_ARTIFACT_BYTE_CAP: "3",
		});

		const safe = await assertHermesArtifactPath(config, safeFile);
		expect(safe.path).toBe(safeFile);
		expect(safe.byteCap).toBe(3);
		await expect(assertHermesArtifactPath(config, escapedLink)).rejects.toThrow(
			"hermes_artifact_outside_allowed_roots",
		);
	});
});
