import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import type { LoadContext } from "../src/capability/types";
import {
	type ScopedConfigurationMutationReceipt,
	ScopedConfigurationMutationService,
	type ScopedConfigurationReloadAndVerify,
	type ScopedConfigurationRuntime,
	type ScopedConfigurationSnapshot,
} from "../src/config/scoped-configuration-mutation";

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-scoped-config-mutation-"));
	temporaryRoots.push(root);
	return root;
}

function context(root: string): LoadContext {
	return {
		cwd: path.join(root, "repo", "nested"),
		home: path.join(root, "home"),
		repoRoot: path.join(root, "repo"),
	};
}

async function createService(
	root: string,
	reloadAndVerify: ScopedConfigurationReloadAndVerify = () => true,
): Promise<ScopedConfigurationMutationService> {
	return new ScopedConfigurationMutationService({
		loadContext: context(root),
		agentDir: path.join(root, "agent"),
		reloadAndVerify,
	});
}

async function readYaml(target: string): Promise<Record<string, unknown>> {
	const parsed: unknown = YAML.parse(await Bun.file(target).text());
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	return parsed as Record<string, unknown>;
}

function digestBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function owner(snapshot: ScopedConfigurationSnapshot): {
	readonly identity: string;
	readonly revision: string;
	readonly digest: string;
} {
	return {
		identity: snapshot.ownerIdentity,
		revision: snapshot.revision,
		digest: snapshot.digest,
	};
}

afterEach(async () => {
	while (temporaryRoots.length > 0) {
		const root = temporaryRoots.pop();
		if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("ScopedConfigurationMutationService", () => {
	it("sets a dotted key and preserves unrelated YAML", async () => {
		const root = await makeRoot();
		const target = path.join(root, "repo", ".gjc", "config.yml");
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, YAML.stringify({ unrelated: { keep: true }, modelProfile: { default: "old" } }, null, 2));
		const service = await createService(root);
		const before = await service.read("project");

		const receipt = await service.mutate({
			scope: "project",
			expectedOwner: owner(before),
			patches: [{ op: "set", path: "modelProfile.default", value: "new" }],
		});

		expect(receipt.status).toBe("committed");
		expect(receipt.timing).toBe("next_session");
		expect(await readYaml(target)).toEqual({ unrelated: { keep: true }, modelProfile: { default: "new" } });
	});

	it("clears only the requested local path", async () => {
		const root = await makeRoot();
		const target = path.join(root, "repo", ".gjc", "config.yml");
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, YAML.stringify({ modelProfile: { default: "local", other: true }, keep: 1 }, null, 2));
		const service = await createService(root);
		const before = await service.read("project");

		const receipt = await service.mutate({
			scope: "project",
			expectedOwner: owner(before),
			patches: [{ op: "clear", path: "modelProfile.default" }],
		});

		expect(receipt.status).toBe("committed");
		expect(await readYaml(target)).toEqual({ modelProfile: { other: true }, keep: 1 });
	});

	it("rejects malformed and conflicting patch batches without a target write", async () => {
		const root = await makeRoot();
		const service = await createService(root);
		const target = path.join(root, "repo", ".gjc", "config.yml");
		const duplicate = await service.mutate({
			scope: "project",
			patches: [
				{ op: "set", path: "a", value: true },
				{ op: "clear", path: "a" },
			],
		});
		const conflict = await service.mutate({
			scope: "project",
			patches: [
				{ op: "set", path: "a", value: true },
				{ op: "set", path: "a.b", value: false },
			],
		});

		expect(duplicate).toMatchObject({ status: "rejected", reason: "duplicate_patch_paths" });
		expect(conflict).toMatchObject({ status: "rejected", reason: "conflicting_patch_paths" });
		expect(await Bun.file(target).exists()).toBe(false);
	});

	it("rejects invalid YAML before mutation", async () => {
		const root = await makeRoot();
		const target = path.join(root, "repo", ".gjc", "config.yml");
		await fs.mkdir(path.dirname(target), { recursive: true });
		const invalid = "modelProfile: [broken\n";
		await Bun.write(target, invalid);
		const service = await createService(root);
		const receipt = await service.mutate({
			scope: "project",
			patches: [{ op: "set", path: "new.key", value: true }],
		});

		expect(receipt).toMatchObject({ status: "rejected", reason: "invalid_yaml" });
		expect(await Bun.file(target).text()).toBe(invalid);
	});

	it("rejects a failed pre-commit runtime callback without writing", async () => {
		const root = await makeRoot();
		const service = await createService(root);
		const runtime: ScopedConfigurationRuntime = { phase: "before_commit", apply: () => false };
		const receipt = await service.mutate({
			scope: "project",
			runtime,
			patches: [{ op: "set", path: "runtime.value", value: true }],
		});

		expect(receipt).toMatchObject({ status: "rejected", reason: "runtime_precommit_failed" });
		expect(await Bun.file(path.join(root, "repo", ".gjc", "config.yml")).exists()).toBe(false);
	});

	it("rejects a commit guard after pre-commit abort without changing durable bytes", async () => {
		const root = await makeRoot();
		const target = path.join(root, "repo", ".gjc", "config.yml");
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, YAML.stringify({ keep: { value: true } }, null, 2));
		const service = await createService(root);
		const before = await service.read("project");
		const beforeBytes = await Bun.file(target).bytes();
		const beforeDigest = digestBytes(beforeBytes);
		const abort = new AbortController();
		let runtimeCalls = 0;
		let guardCalls = 0;

		const receipt = await service.mutate({
			scope: "project",
			expectedOwner: owner(before),
			runtime: {
				phase: "before_commit",
				apply: () => {
					runtimeCalls += 1;
					abort.abort();
					return true;
				},
			},
			commitGuard: () => {
				guardCalls += 1;
				return abort.signal.aborted !== true;
			},
			patches: [{ op: "set", path: "runtime.value", value: true }],
		});

		expect(receipt).toMatchObject({ status: "rejected", reason: "runtime_precommit_failed" });
		expect(runtimeCalls).toBe(1);
		expect(guardCalls).toBe(1);
		const afterBytes = await Bun.file(target).bytes();
		expect(afterBytes).toEqual(beforeBytes);
		expect(digestBytes(afterBytes)).toBe(beforeDigest);
	});

	it("turns a throwing commit guard into a safe pre-commit rejection", async () => {
		const root = await makeRoot();
		const target = path.join(root, "repo", ".gjc", "config.yml");
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, YAML.stringify({ keep: { value: true } }, null, 2));
		const service = await createService(root);
		const before = await service.read("project");
		const beforeBytes = await Bun.file(target).bytes();
		const secret = "commit-guard-secret";
		const receipt = await service.mutate({
			scope: "project",
			expectedOwner: owner(before),
			commitGuard: () => {
				throw new Error(secret);
			},
			patches: [{ op: "set", path: "runtime.value", value: true }],
		});

		expect(receipt).toMatchObject({ status: "rejected", reason: "runtime_precommit_failed" });
		expect(JSON.stringify(receipt)).not.toContain(secret);
		expect(await Bun.file(target).bytes()).toEqual(beforeBytes);
	});

	it("reports post-commit runtime failure as degraded while retaining the durable write", async () => {
		const root = await makeRoot();
		const service = await createService(root);
		const runtime: ScopedConfigurationRuntime = { phase: "after_commit", apply: () => false };
		const receipt = await service.mutate({
			scope: "project",
			runtime,
			patches: [{ op: "set", path: "runtime.value", value: true }],
		});

		expect(receipt).toMatchObject({ status: "degraded", reason: "runtime_postcommit_failed" });
		expect(await Bun.file(path.join(root, "repo", ".gjc", "config.yml")).exists()).toBe(true);
	});

	it("keeps receipts safe and marks reload mismatch as committed-unconfirmed", async () => {
		const root = await makeRoot();
		const service = await createService(root, () => false);
		const secret = "receipt-secret-must-not-escape";
		const receipt: ScopedConfigurationMutationReceipt = await service.mutate({
			scope: "project",
			patches: [{ op: "set", path: "auth.token", value: secret }],
		});

		expect(receipt).toMatchObject({
			status: "degraded",
			reason: "persistent_reload_mismatch",
			durability: "committed_unconfirmed",
		});
		expect(JSON.stringify(receipt)).not.toContain(secret);
	});
});
