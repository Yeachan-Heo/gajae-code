import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "../src/capability/types";
import {
	ScopedConfigurationMutationService,
	type ScopedConfigurationReloadAndVerify,
} from "../src/config/scoped-configuration-mutation";

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-scoped-config-root-"));
	temporaryRoots.push(root);
	return root;
}

function loadContext(root: string, repoRoot: string | null): LoadContext {
	return {
		cwd: path.join(root, "repo", "nested", "cwd"),
		home: path.join(root, "home"),
		repoRoot,
	};
}

function service(root: string, repoRoot: string | null): ScopedConfigurationMutationService {
	const reloadAndVerify: ScopedConfigurationReloadAndVerify = () => true;
	return new ScopedConfigurationMutationService({
		loadContext: loadContext(root, repoRoot),
		agentDir: path.join(root, "agent"),
		reloadAndVerify,
	});
}

afterEach(async () => {
	while (temporaryRoots.length > 0) {
		const root = temporaryRoots.pop();
		if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("scoped configuration root binding and path safety", () => {
	it("uses repoRoot rather than nested cwd and refuses missing repo roots", async () => {
		const root = await makeRoot();
		const repoRoot = path.join(root, "repo");
		await fs.mkdir(path.join(repoRoot, "nested", "cwd"), { recursive: true });
		const bound = service(root, repoRoot);
		const boundReceipt = await bound.mutate({
			scope: "project",
			patches: [{ op: "set", path: "owner.value", value: "root" }],
		});
		const missing = service(root, null);
		const missingReceipt = await missing.mutate({
			scope: "project",
			patches: [{ op: "set", path: "owner.value", value: "cwd" }],
		});

		expect(boundReceipt.status).toBe("committed");
		expect(await Bun.file(path.join(repoRoot, ".gjc", "config.yml")).exists()).toBe(true);
		expect(missingReceipt).toMatchObject({ status: "locked", reason: "project_scope_unavailable" });
	});

	it("writes only the exact owned user target", async () => {
		const root = await makeRoot();
		const agentDir = path.join(root, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		const userService = new ScopedConfigurationMutationService({
			loadContext: loadContext(root, path.join(root, "repo")),
			agentDir,
			reloadAndVerify: () => true,
		});

		const receipt = await userService.mutate({
			scope: "user",
			patches: [{ op: "set", path: "user.value", value: 1 }],
		});

		expect(receipt.status).toBe("committed");
		expect(await Bun.file(path.join(agentDir, "config.yml")).exists()).toBe(true);
		expect(await Bun.file(path.join(root, "repo", ".gjc", "config.yml")).exists()).toBe(false);
	});

	it("rejects a symlink in the target path and does not follow it", async () => {
		const root = await makeRoot();
		const repoRoot = path.join(root, "repo");
		const outside = path.join(root, "outside.yml");
		const target = path.join(repoRoot, ".gjc", "config.yml");
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(outside, "outside: true\n");
		await fs.symlink(outside, target);
		const result = await service(root, repoRoot).mutate({
			scope: "project",
			patches: [{ op: "set", path: "owned.value", value: true }],
		});

		expect(result).toMatchObject({ status: "rejected", reason: "target_symlink" });
		expect(await Bun.file(outside).text()).toBe("outside: true\n");
	});

	it("rejects a symlinked parent and non-regular target", async () => {
		const root = await makeRoot();
		const repoRoot = path.join(root, "repo");
		const realConfigDir = path.join(root, "real-config");
		await fs.mkdir(realConfigDir, { recursive: true });
		await fs.mkdir(repoRoot, { recursive: true });
		await fs.symlink(realConfigDir, path.join(repoRoot, ".gjc"));
		const parentResult = await service(root, repoRoot).mutate({
			scope: "project",
			patches: [{ op: "set", path: "owned.value", value: true }],
		});
		expect(parentResult).toMatchObject({ status: "rejected", reason: "target_symlink" });

		const secondRoot = await makeRoot();
		const secondRepo = path.join(secondRoot, "repo");
		const nonregular = path.join(secondRepo, ".gjc", "config.yml");
		await fs.mkdir(nonregular, { recursive: true });
		const nonregularResult = await service(secondRoot, secondRepo).mutate({
			scope: "project",
			patches: [{ op: "set", path: "owned.value", value: true }],
		});
		expect(nonregularResult).toMatchObject({ status: "rejected", reason: "target_non_regular" });
	});
});
