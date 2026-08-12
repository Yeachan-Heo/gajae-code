import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "../src/capability/types";
import { ScopedConfigurationMutationService } from "../src/config/scoped-configuration-mutation";

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-scoped-config-cas-"));
	temporaryRoots.push(root);
	return root;
}

function makeService(root: string): ScopedConfigurationMutationService {
	const loadContext: LoadContext = {
		cwd: path.join(root, "repo", "nested"),
		home: path.join(root, "home"),
		repoRoot: path.join(root, "repo"),
	};
	return new ScopedConfigurationMutationService({
		loadContext,
		agentDir: path.join(root, "agent"),
		reloadAndVerify: () => true,
	});
}

afterEach(async () => {
	while (temporaryRoots.length > 0) {
		const root = temporaryRoots.pop();
		if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("scoped configuration CAS and reservation", () => {
	it("rejects a stale expected owner without mutating the target", async () => {
		const root = await makeRoot();
		const target = path.join(root, "repo", ".gjc", "config.yml");
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, "value: old\n");
		const service = makeService(root);
		const before = await service.read("project");
		await Bun.write(target, "value: foreign\n");

		const receipt = await service.mutate({
			scope: "project",
			expectedOwner: {
				identity: before.ownerIdentity,
				revision: before.revision,
				digest: before.digest,
			},
			patches: [{ op: "set", path: "value", value: "ours" }],
		});

		expect(receipt).toMatchObject({ status: "conflict", reason: "scope_conflict" });
		expect(await Bun.file(target).text()).toBe("value: foreign\n");
	});

	it("serializes concurrent reservations and lets only one old snapshot win", async () => {
		const root = await makeRoot();
		const first = makeService(root);
		const second = makeService(root);
		const firstBefore = await first.read("project");
		const secondBefore = await second.read("project");
		const expectedOwner = {
			identity: firstBefore.ownerIdentity,
			revision: firstBefore.revision,
			digest: firstBefore.digest,
		};
		const [firstReceipt, secondReceipt] = await Promise.all([
			first.mutate({
				scope: "project",
				expectedOwner,
				patches: [{ op: "set", path: "winner", value: "first" }],
			}),
			second.mutate({
				scope: "project",
				expectedOwner: {
					identity: secondBefore.ownerIdentity,
					revision: secondBefore.revision,
					digest: secondBefore.digest,
				},
				patches: [{ op: "set", path: "winner", value: "second" }],
			}),
		]);

		expect([firstReceipt.status, secondReceipt.status].sort()).toEqual(["committed", "conflict"]);
		const text = await Bun.file(path.join(root, "repo", ".gjc", "config.yml")).text();
		expect(text).toContain("winner:");
	});

	it("does not write for managed or invalid-value outcomes", async () => {
		const root = await makeRoot();
		const service = makeService(root);
		const managed = await service.mutate({
			scope: "managed",
			patches: [{ op: "set", path: "value", value: true }],
		});
		const invalidValue = { nested: undefined } as unknown;
		const rejected = await service.mutate({
			scope: "project",
			patches: [{ op: "set", path: "value", value: invalidValue as never }],
		});

		expect(managed).toMatchObject({ status: "locked", reason: "scope_locked" });
		expect(rejected).toMatchObject({ status: "rejected", reason: "unsupported_value" });
		expect(await Bun.file(path.join(root, "repo", ".gjc", "config.yml")).exists()).toBe(false);
	});
});
