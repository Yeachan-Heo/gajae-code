import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	EphemeralBlobStore,
	openVerifiedResidentCacheInstanceDir,
	sweepResidentCacheRoot,
} from "@gajae-code/coding-agent/session/blob-store";

const temporaryDirectories: string[] = [];
const DEAD_PID = 2_147_483_647;

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.promises.rm(directory, { recursive: true, force: true })),
	);
});

interface ResidentCacheOwner {
	pid: number;
	startTimeMs: number | null;
	nonce: string;
	createdAt?: number;
}

function makeTempDir(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resident-cache-gc-"));
	temporaryDirectories.push(directory);
	return directory;
}

function makeVerifiedRoot(root: string): void {
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	fs.chmodSync(root, 0o700);
}

function writeOwner(instanceDir: string, owner: ResidentCacheOwner): void {
	fs.writeFileSync(path.join(instanceDir, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
	fs.chmodSync(path.join(instanceDir, "owner.json"), 0o600);
}

function createInstance(root: string, name: string, owner: ResidentCacheOwner): string {
	const instanceDir = path.join(root, name);
	fs.mkdirSync(instanceDir, { mode: 0o700 });
	fs.chmodSync(instanceDir, 0o700);
	writeOwner(instanceDir, owner);
	return instanceDir;
}

function instanceDirectories(root: string): string[] {
	return fs
		.readdirSync(root)
		.filter(name => /^i-[A-Za-z0-9_-]+$/.test(name))
		.map(name => path.join(root, name))
		.filter(directory => fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink());
}

function currentProcessStartTimeMs(): number | null {
	const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.pid)], {
		stdout: "pipe",
		stderr: "ignore",
		env: { ...process.env, LC_ALL: "C", LANG: "C" },
	});
	if (result.exitCode !== 0) return null;
	const startTimeMs = Date.parse(new TextDecoder().decode(result.stdout).trim());
	return Number.isFinite(startTimeMs) ? startTimeMs : null;
}

describe.skipIf(process.platform === "win32")("resident-cache lease-aware GC", () => {
	it("writes an owner-only process lease before returning an instance directory", () => {
		const root = path.join(makeTempDir(), "resident-cache");
		const instanceDir = openVerifiedResidentCacheInstanceDir(root);
		const store = EphemeralBlobStore.adoptVerifiedDir(instanceDir);
		try {
			const owner = JSON.parse(fs.readFileSync(path.join(instanceDir, "owner.json"), "utf8")) as ResidentCacheOwner;
			expect(owner.pid).toBe(process.pid);
			expect(owner.nonce).toBe(path.basename(instanceDir).slice("i-".length));
			expect(typeof owner.startTimeMs === "number" || owner.startTimeMs === null).toBe(true);
			expect(fs.statSync(path.join(instanceDir, "owner.json")).mode & 0o777).toBe(0o600);
		} finally {
			store.dispose();
		}
	});

	it("collects an instance whose owner PID is dead", async () => {
		const cacheRoot = path.join(makeTempDir(), "resident-cache");
		makeVerifiedRoot(cacheRoot);
		const stale = createInstance(cacheRoot, "i-dead-owner", {
			pid: DEAD_PID,
			startTimeMs: 0,
			nonce: "dead-owner",
		});

		await sweepResidentCacheRoot(cacheRoot);

		expect(fs.existsSync(stale)).toBe(false);
	});

	it("schedules a stale-instance sweep when a verified root opens", async () => {
		const cacheRoot = path.join(makeTempDir(), "resident-cache");
		makeVerifiedRoot(cacheRoot);
		const stale = createInstance(cacheRoot, "i-scheduled-dead-owner", {
			pid: DEAD_PID,
			startTimeMs: 0,
			nonce: "scheduled-dead-owner",
		});
		const active = EphemeralBlobStore.adoptVerifiedDir(openVerifiedResidentCacheInstanceDir(cacheRoot));
		try {
			for (let attempt = 0; attempt < 20 && fs.existsSync(stale); attempt++) {
				await Bun.sleep(5);
			}
			expect(fs.existsSync(stale)).toBe(false);
		} finally {
			active.dispose();
		}
	});

	it("preserves an instance with a live PID and matching start time", async () => {
		const cacheRoot = path.join(makeTempDir(), "resident-cache");
		makeVerifiedRoot(cacheRoot);
		const live = createInstance(cacheRoot, "i-live-owner", {
			pid: process.pid,
			startTimeMs: currentProcessStartTimeMs(),
			nonce: "live-owner",
		});

		await sweepResidentCacheRoot(cacheRoot);

		expect(fs.existsSync(live)).toBe(true);
	});

	it("collects a PID-reuse ABA owner whose live PID has a mismatched start time", async () => {
		const startTimeMs = currentProcessStartTimeMs();
		if (startTimeMs === null) throw new Error("The host did not provide a process start time.");
		const cacheRoot = path.join(makeTempDir(), "resident-cache");
		makeVerifiedRoot(cacheRoot);
		const stale = createInstance(cacheRoot, "i-reused-pid", {
			pid: process.pid,
			startTimeMs: startTimeMs + 60_000,
			nonce: "reused-pid",
		});

		await sweepResidentCacheRoot(cacheRoot);

		expect(fs.existsSync(stale)).toBe(false);
	});

	it("refuses a reap when the owner token changes after the stale observation", async () => {
		const cacheRoot = path.join(makeTempDir(), "resident-cache");
		makeVerifiedRoot(cacheRoot);
		const stale = createInstance(cacheRoot, "i-owner-replaced", {
			pid: DEAD_PID,
			startTimeMs: 0,
			nonce: "before-replacement",
		});
		const ownerPath = path.join(stale, "owner.json");
		const readFileSync = fs.readFileSync;
		let replaced = false;
		vi.spyOn(fs, "readFileSync").mockImplementation(((filePath: fs.PathOrFileDescriptor, options?: unknown) => {
			const result = (readFileSync as (file: fs.PathOrFileDescriptor, options?: unknown) => string | Buffer)(
				filePath,
				options,
			);
			if (!replaced && typeof filePath === "string" && path.resolve(filePath) === ownerPath) {
				replaced = true;
				writeOwner(stale, { pid: DEAD_PID, startTimeMs: 0, nonce: "after-replacement" });
			}
			return result;
		}) as typeof fs.readFileSync);

		await sweepResidentCacheRoot(cacheRoot);

		expect(replaced).toBe(true);
		expect(fs.existsSync(stale)).toBe(true);
	});

	it("processes no more than 64 stale instance directories in one sweep", async () => {
		const cacheRoot = path.join(makeTempDir(), "resident-cache");
		makeVerifiedRoot(cacheRoot);
		for (let index = 0; index < 70; index++) {
			const suffix = index.toString().padStart(2, "0");
			createInstance(cacheRoot, `i-budget-${suffix}`, {
				pid: DEAD_PID,
				startTimeMs: 0,
				nonce: `budget-${suffix}`,
			});
		}

		await sweepResidentCacheRoot(cacheRoot);

		const removed = 70 - instanceDirectories(cacheRoot).length;
		expect(removed).toBeGreaterThan(0);
		expect(removed).toBeLessThanOrEqual(64);
		expect(instanceDirectories(cacheRoot).length).toBeGreaterThanOrEqual(6);
	});

	it("quarantines and deletes a stale tree without following a planted symlink", async () => {
		const root = makeTempDir();
		const cacheRoot = path.join(root, "resident-cache");
		const protectedDirectory = path.join(root, "protected");
		makeVerifiedRoot(cacheRoot);
		fs.mkdirSync(protectedDirectory, { mode: 0o700 });
		const protectedFile = path.join(protectedDirectory, "must-survive.txt");
		fs.writeFileSync(protectedFile, "outside the resident cache", { mode: 0o600 });
		const stale = createInstance(cacheRoot, "i-symlinked-tree", {
			pid: DEAD_PID,
			startTimeMs: 0,
			nonce: "symlinked-tree",
		});
		fs.symlinkSync(protectedDirectory, path.join(stale, "planted-link"), "dir");

		await sweepResidentCacheRoot(cacheRoot);

		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.readFileSync(protectedFile, "utf8")).toBe("outside the resident cache");
	});

	it("surfaces an unexpected scan failure and clears the active sweep guard", async () => {
		const cacheRoot = path.join(makeTempDir(), "resident-cache");
		makeVerifiedRoot(cacheRoot);
		const scan = vi.spyOn(fs, "opendirSync").mockImplementation(() => {
			throw new Error("injected unexpected resident cache scan failure");
		});

		await expect(sweepResidentCacheRoot(cacheRoot)).rejects.toThrow(
			"injected unexpected resident cache scan failure",
		);

		scan.mockRestore();
		await expect(sweepResidentCacheRoot(cacheRoot)).resolves.toBeUndefined();
	});
});
