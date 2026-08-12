import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "../src/capability/types";
import {
	NativeProjectSettingsStore,
	type ScopedConfigurationSnapshot,
} from "../src/config/scoped-configuration-mutation";

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-scoped-config-store-"));
	temporaryRoots.push(root);
	return root;
}

function context(cwd: string, repoRoot: string | null): LoadContext {
	return { cwd, home: path.dirname(cwd), repoRoot };
}

async function readProject(store: NativeProjectSettingsStore): Promise<ScopedConfigurationSnapshot> {
	return await store.read("project");
}

afterEach(async () => {
	while (temporaryRoots.length > 0) {
		const root = temporaryRoots.pop();
		if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("NativeProjectSettingsStore", () => {
	it("binds nested working directories to the repository root target", async () => {
		const root = await makeRoot();
		const repoRoot = path.join(root, "repo");
		const nestedCwd = path.join(repoRoot, "packages", "app");
		await fs.mkdir(path.join(nestedCwd), { recursive: true });
		const store = new NativeProjectSettingsStore({
			loadContext: context(nestedCwd, repoRoot),
			agentDir: path.join(root, "agent"),
		});

		expect(store.target("project")).toBe(path.join(repoRoot, ".gjc", "config.yml"));
		const snapshot = await readProject(store);
		expect(snapshot.path).toBe(path.join(repoRoot, ".gjc", "config.yml"));
		expect(snapshot.exists).toBe(false);
	});

	it("rejects project reads without a repository root", async () => {
		const root = await makeRoot();
		const store = new NativeProjectSettingsStore({
			loadContext: context(path.join(root, "cwd"), null),
			agentDir: path.join(root, "agent"),
		});

		await expect(readProject(store)).rejects.toMatchObject({ code: "project_scope_unavailable" });
	});

	it("uses exactly the owned user target", async () => {
		const root = await makeRoot();
		const agentDir = path.join(root, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), "theme: dark\n");
		const store = new NativeProjectSettingsStore({
			loadContext: context(path.join(root, "cwd"), path.join(root, "repo")),
			agentDir,
		});

		const snapshot = await store.read("user");
		expect(snapshot.path).toBe(path.join(agentDir, "config.yml"));
		expect(snapshot.data).toEqual({ theme: "dark" });
	});

	it("never treats managed as a writable native store", async () => {
		const root = await makeRoot();
		const store = new NativeProjectSettingsStore({
			loadContext: context(path.join(root, "cwd"), path.join(root, "repo")),
			agentDir: path.join(root, "agent"),
		});

		await expect(store.read("managed")).rejects.toMatchObject({ code: "scope_locked" });
	});
});
