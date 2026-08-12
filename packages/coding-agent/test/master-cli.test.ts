import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commands } from "../src/cli";
import { type MasterCommandDeps, parseMasterArgs, runMasterCommand } from "../src/cli/master-cli";
import { MasterDaemonController } from "../src/master/daemon-control";
import { MasterDomainStore } from "../src/master/domain-store";

const roots: string[] = [];

async function makeRoot(): Promise<{ root: string; workdir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-master-cli-"));
	roots.push(root);
	const workdir = path.join(root, "workdir");
	await fs.mkdir(workdir);
	return { root: path.join(root, "master"), workdir };
}

function outputDeps(root: string, _workdir: string, extra: Partial<MasterCommandDeps> = {}): MasterCommandDeps {
	return {
		masterRootDir: root,
		authorize: () => true,
		daemonController: { reload: async () => ({ ok: true, warnings: [], message: "reloaded" }) },
		...extra,
		...(extra.writeStdout === undefined ? { writeStdout: () => undefined } : {}),
		...(extra.writeStderr === undefined ? { writeStderr: () => undefined } : {}),
	};
}

afterEach(async () => {
	while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

describe("master command registration and strict parsing", () => {
	it("registers the root master command", () => {
		expect(commands.some(command => command.name === "master")).toBe(true);
	}, 30_000);

	it("parses create, list, and configure forms with strict flags", () => {
		expect(parseMasterArgs(["master", "create", "alpha", "--max-concurrent-workers", "4"])).toEqual({
			action: "create",
			name: "alpha",
			maxConcurrentWorkers: 4,
		});
		expect(parseMasterArgs(["master", "list", "--json"])).toEqual({ action: "list", json: true });
		expect(parseMasterArgs(["master", "configure", "alpha", "--max-concurrent-workers=5"])).toEqual({
			action: "configure",
			name: "alpha",
			maxConcurrentWorkers: 5,
		});
		expect(() => parseMasterArgs(["master", "list", "alpha"])).toThrow();
		expect(() => parseMasterArgs(["master", "create", "Alpha"])).toThrow();
		expect(() => parseMasterArgs(["master", "configure", "alpha", "--max-concurrent-workers", "0"])).toThrow();
	}, 30_000);
});

describe("master create/list/configure lifecycle", () => {
	it("uses the default capacity, lists records, and configures capacity", async () => {
		const { root, workdir } = await makeRoot();
		const deps = outputDeps(root, workdir);
		const created = await runMasterCommand({ action: "create", name: "alpha", workdir }, deps);
		expect(created.record?.maxConcurrentWorkers).toBe(3);
		const listed = await runMasterCommand({ action: "list", json: true }, deps);
		expect(listed.masters?.map(item => item.masterName)).toEqual(["alpha"]);
		const configured = await runMasterCommand({ action: "configure", name: "alpha", maxConcurrentWorkers: 5 }, deps);
		expect(configured.record?.maxConcurrentWorkers).toBe(5);
	}, 30_000);

	it("rejects duplicate creates without reloading the daemon", async () => {
		const { root, workdir } = await makeRoot();
		let reloads = 0;
		const deps = outputDeps(root, workdir, {
			daemonController: new MasterDaemonController({
				reload: async () => {
					reloads += 1;
					return { ok: true, warnings: [], message: "reloaded" };
				},
			}),
		});
		await runMasterCommand({ action: "create", name: "alpha", workdir }, deps);
		await expect(runMasterCommand({ action: "create", name: "alpha", workdir }, deps)).rejects.toThrow(
			/already exists/i,
		);
		expect(reloads).toBe(1);
	}, 30_000);

	it("persists before reload and retains the record when reload fails", async () => {
		const { root, workdir } = await makeRoot();
		const order: string[] = [];
		const deps = outputDeps(root, workdir, {
			createStore: async options => {
				order.push("persist");
				return await MasterDomainStore.create(options);
			},
			daemonController: new MasterDaemonController({
				reload: async () => {
					order.push("reload");
					return { ok: false, warnings: ["owner unavailable"], message: "reload failed" };
				},
			}),
		});
		const result = await runMasterCommand({ action: "create", name: "recoverable", workdir }, deps);
		expect(order).toEqual(["persist", "reload"]);
		expect(result.ok).toBe(false);
		expect(await MasterDomainStore.exists({ masterName: "recoverable", masterRootDir: root })).toBe(true);
	}, 30_000);

	it("rejects missing and symlinked workdirs before persistence", async () => {
		const { root, workdir } = await makeRoot();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-master-outside-"));
		roots.push(outside);
		const linked = path.join(path.dirname(workdir), "linked");
		await fs.symlink(outside, linked, "dir");
		const deps = outputDeps(root, workdir);
		await expect(
			runMasterCommand({ action: "create", name: "missing", workdir: path.join(root, "none") }, deps),
		).rejects.toThrow();
		await expect(runMasterCommand({ action: "create", name: "linked", workdir: linked }, deps)).rejects.toThrow();
		expect(await MasterDomainStore.exists({ masterName: "missing", masterRootDir: root })).toBe(false);
	}, 30_000);
});
