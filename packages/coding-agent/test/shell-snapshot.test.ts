import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createShellSnapshotCacheForTesting } from "../src/utils/shell-snapshot";

const BASH_PATH = "/bin/bash";
const temporaryRoots: string[] = [];
async function makeHarness(platform: NodeJS.Platform = process.platform) {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-shell-snapshot-test-"));
	temporaryRoots.push(tempRoot);
	const home = path.join(tempRoot, "home");
	await fs.mkdir(home);
	return {
		tempRoot,
		cache: createShellSnapshotCacheForTesting({ tempRoot, home, platform }),
	};
}
afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
describe("shell snapshot private cache", () => {
	it("uses one owner-private root and leaf while leaving the legacy path untouched", async () => {
		if (process.platform === "win32" || !(await Bun.file(BASH_PATH).exists())) return;
		const bash = BASH_PATH;
		const { cache, tempRoot } = await makeHarness();
		const legacyTarget = path.join(tempRoot, "legacy-target");
		const legacyPath = path.join(tempRoot, "gjc-shell-snapshots");
		await fs.mkdir(legacyTarget);
		await Bun.write(path.join(legacyTarget, "sentinel"), "untouched");
		await fs.symlink(legacyTarget, legacyPath, "dir");
		const env = { HOME: path.join(tempRoot, "home"), PATH: Bun.env.PATH };
		const snapshots = await Promise.all(Array.from({ length: 8 }, () => cache.getOrCreateSnapshot(bash, env)));
		const snapshotPath = snapshots[0];
		if (!snapshotPath) throw new Error("expected a shell snapshot");
		expect(new Set(snapshots)).toEqual(new Set([snapshotPath]));
		expect(await cache.getOrCreateSnapshot(bash, env)).toBe(snapshotPath);
		const privateRoot = path.dirname(snapshotPath);
		const rootStat = await fs.lstat(privateRoot);
		const leafStat = await fs.lstat(snapshotPath);
		expect(rootStat.isDirectory()).toBe(true);
		expect(rootStat.mode & 0o777).toBe(0o700);
		expect(leafStat.isFile()).toBe(true);
		expect(leafStat.mode & 0o777).toBe(0o600);
		if (typeof process.getuid === "function") {
			expect(rootStat.uid).toBe(process.getuid());
			expect(leafStat.uid).toBe(process.getuid());
		}
		expect((await fs.readdir(tempRoot)).filter(name => name.startsWith("gjc-shell-snapshots-"))).toHaveLength(1);
		expect(await fs.readdir(privateRoot)).toEqual([path.basename(snapshotPath)]);
		expect((await fs.lstat(legacyPath)).isSymbolicLink()).toBe(true);
		expect(await Bun.file(path.join(legacyTarget, "sentinel")).text()).toBe("untouched");
		await fs.chmod(snapshotPath, 0o644);
		const replacement = await cache.getOrCreateSnapshot(bash, env);
		expect(replacement).not.toBe(snapshotPath);
		await cache.cleanup();
		expect(fs.lstat(privateRoot)).rejects.toThrow();
		expect((await fs.lstat(legacyPath)).isSymbolicLink()).toBe(true);
	});
	it("cleans a failed reservation and permits a later retry", async () => {
		if (process.platform === "win32" || !(await Bun.file(BASH_PATH).exists())) return;
		const bash = BASH_PATH;
		const { cache, tempRoot } = await makeHarness();
		const wrapper = path.join(tempRoot, "test-bash");
		await Bun.write(wrapper, "#!/bin/sh\nexit 1\n");
		await fs.chmod(wrapper, 0o700);
		const env = { HOME: path.join(tempRoot, "home"), PATH: Bun.env.PATH };
		expect(await cache.getOrCreateSnapshot(wrapper, env)).toBeNull();
		const privateRoot = path.join(
			tempRoot,
			(await fs.readdir(tempRoot)).find(name => name.startsWith("gjc-shell-snapshots-")) ?? "missing",
		);
		expect(await fs.readdir(privateRoot)).toEqual([]);
		await Bun.write(wrapper, `#!/bin/sh\nexec ${bash} "$@"\n`);
		await fs.chmod(wrapper, 0o700);
		expect(await cache.getOrCreateSnapshot(wrapper, env)).not.toBeNull();
	});
	it("waits for active creation before removing and resetting its private root", async () => {
		if (process.platform === "win32" || !(await Bun.file(BASH_PATH).exists())) return;
		const bash = BASH_PATH;
		const { cache, tempRoot } = await makeHarness();
		const wrapper = path.join(tempRoot, "slow-bash");
		await Bun.write(wrapper, `#!/bin/sh\nsleep 0.2\nexec ${bash} "$@"\n`);
		await fs.chmod(wrapper, 0o700);
		const env = { HOME: path.join(tempRoot, "home"), PATH: Bun.env.PATH };
		const creation = cache.getOrCreateSnapshot(wrapper, env);
		await Bun.sleep(30);
		const cleanup = cache.cleanup();
		expect(await cache.getOrCreateSnapshot(wrapper, env)).toBeNull();
		const [createdDuringCleanup] = await Promise.all([creation, cleanup]);
		expect(createdDuringCleanup).toBeNull();
		expect((await fs.readdir(tempRoot)).filter(name => name.startsWith("gjc-shell-snapshots-"))).toEqual([]);
		expect(await cache.getOrCreateSnapshot(wrapper, env)).not.toBeNull();
		await cache.cleanup();
	});
	it("returns on Windows before creating any artifact", async () => {
		const { tempRoot } = await makeHarness("win32");
		const missingRoot = path.join(tempRoot, "must-not-exist");
		const isolatedCache = createShellSnapshotCacheForTesting({
			tempRoot: missingRoot,
			home: path.join(tempRoot, "home"),
			platform: "win32",
		});
		expect(await isolatedCache.getOrCreateSnapshot("missing-shell", {})).toBeNull();
		expect(fs.lstat(missingRoot)).rejects.toThrow();
		await isolatedCache.cleanup();
	});
});
