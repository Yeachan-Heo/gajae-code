import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, getResidentCacheRootDir, setAgentDir } from "@gajae-code/utils";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";

const originalAgentDir = getAgentDir();
const environmentKeys = [
	"GJC_CODING_AGENT_DIR",
	"GJC_CONFIG_DIR",
	"PI_CONFIG_DIR",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
] as const;
const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
const temporaryDirectories: string[] = [];

beforeEach(() => {
	setAgentDir(path.join(makeTempDir(), "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	restoreEnvironment();
	setAgentDir(originalAgentDir);
	const originalAgentDirOverride = originalEnvironment.get("GJC_CODING_AGENT_DIR");
	if (originalAgentDirOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
	else process.env.GJC_CODING_AGENT_DIR = originalAgentDirOverride;
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.promises.rm(directory, { recursive: true, force: true })),
	);
});

function makeTempDir(prefix = "gjc-resident-root-derivation-"): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function restoreEnvironment(): void {
	for (const key of environmentKeys) {
		const value = originalEnvironment.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function ensurePrivateDirectory(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
}

function residentInstanceDirs(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root)
		.map(name => path.join(root, name))
		.filter(directory => {
			const stat = fs.lstatSync(directory);
			return path.basename(directory).startsWith("i-") && stat.isDirectory() && !stat.isSymbolicLink();
		});
}

function appendLargeUserText(manager: SessionManager, text: string): void {
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

describe.skipIf(process.platform === "win32")("resident cache root derivation", () => {
	it("routes default-managed resident caches to XDG cache without creating a cache under XDG data", async () => {
		const root = makeTempDir();
		const xdgCacheHome = path.join(root, "xdg-cache");
		const xdgDataHome = path.join(root, "xdg-data");
		const xdgCacheRoot = path.join(xdgCacheHome, "gjc");
		const xdgDataRoot = path.join(xdgDataHome, "gjc");
		ensurePrivateDirectory(xdgCacheRoot);
		ensurePrivateDirectory(xdgDataRoot);
		process.env.XDG_CACHE_HOME = xdgCacheHome;
		process.env.XDG_DATA_HOME = xdgDataHome;
		delete process.env.GJC_CONFIG_DIR;
		delete process.env.PI_CONFIG_DIR;
		delete process.env.GJC_CODING_AGENT_DIR;

		const defaultAgentDir = path.join(os.homedir(), ".gjc", "agent");
		setAgentDir(defaultAgentDir);
		const cwd = path.join(root, "workspace");
		ensurePrivateDirectory(cwd);
		const expectedCacheRoot = path.join(xdgCacheRoot, "resident-cache");
		const manager = SessionManager.create(cwd);
		try {
			appendLargeUserText(manager, `xdg managed ${"x".repeat(4096)}`);
			await manager.ensureOnDisk();
			await manager.flush();

			expect(getResidentCacheRootDir(getAgentDir())).toBe(expectedCacheRoot);
			expect(residentInstanceDirs(expectedCacheRoot)).toHaveLength(1);
			expect(isWithin(xdgDataRoot, manager.getSessionDir())).toBe(true);
			expect(fs.existsSync(path.join(xdgDataRoot, "resident-cache"))).toBe(false);
		} finally {
			await manager.close().catch(() => {});
		}
	});

	it("binds a managed SDK custom agentDir to its own resident-cache root", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const customAgentDir = path.join(root, "sdk-agent");
		ensurePrivateDirectory(cwd);
		ensurePrivateDirectory(customAgentDir);
		const destination = SessionManager.managedDestination(cwd, customAgentDir);
		const manager = SessionManager.create(cwd, destination);
		const expectedCacheRoot = path.join(customAgentDir, "resident-cache");
		try {
			appendLargeUserText(manager, `custom profile ${"c".repeat(4096)}`);
			await manager.ensureOnDisk();

			expect(getResidentCacheRootDir(customAgentDir)).toBe(expectedCacheRoot);
			expect(residentInstanceDirs(expectedCacheRoot)).toHaveLength(1);
			expect(fs.existsSync(path.join(getAgentDir(), "resident-cache"))).toBe(false);
		} finally {
			await manager.close().catch(() => {});
		}
	});

	it("keeps two managed profile agent directories in disjoint resident-cache roots", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const firstAgentDir = path.join(root, "profile-a");
		const secondAgentDir = path.join(root, "profile-b");
		ensurePrivateDirectory(cwd);
		ensurePrivateDirectory(firstAgentDir);
		ensurePrivateDirectory(secondAgentDir);

		const first = SessionManager.create(cwd, SessionManager.managedDestination(cwd, firstAgentDir));
		const second = SessionManager.create(cwd, SessionManager.managedDestination(cwd, secondAgentDir));
		const firstRoot = getResidentCacheRootDir(firstAgentDir);
		const secondRoot = getResidentCacheRootDir(secondAgentDir);
		try {
			appendLargeUserText(first, `profile a ${"a".repeat(4096)}`);
			appendLargeUserText(second, `profile b ${"b".repeat(4096)}`);
			await first.ensureOnDisk();
			await second.ensureOnDisk();

			expect(firstRoot).not.toBe(secondRoot);
			expect(residentInstanceDirs(firstRoot)).toHaveLength(1);
			expect(residentInstanceDirs(secondRoot)).toHaveLength(1);
			expect(residentInstanceDirs(firstRoot)[0]!.startsWith(firstRoot)).toBe(true);
			expect(residentInstanceDirs(secondRoot)[0]!.startsWith(secondRoot)).toBe(true);
		} finally {
			await Promise.all([first.close().catch(() => {}), second.close().catch(() => {})]);
		}
	});

	it("preserves an SDK custom profile root through openNestedManaged", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const customAgentDir = path.join(root, "sdk-agent");
		ensurePrivateDirectory(cwd);
		ensurePrivateDirectory(customAgentDir);

		const parentDestination = SessionManager.managedDestination(cwd, customAgentDir);
		if (parentDestination.kind !== "managed") throw new Error("Expected a managed parent destination");
		const parent = SessionManager.create(cwd, parentDestination);
		try {
			appendLargeUserText(parent, `parent profile ${"p".repeat(4096)}`);
			await parent.ensureOnDisk();
		} finally {
			await parent.close().catch(() => {});
		}

		const parentStore = new ManagedSessionDescendantStore(
			parentDestination.securityContext.rootAuthority,
			parentDestination.directory,
			undefined,
			undefined,
			parentDestination.securityContext.profileAgentDir,
		);
		const nestedStore = parentStore.deriveSubtree("nested");
		const nestedDestination = SessionManager.nestedManagedDestination(nestedStore, nestedStore.dir);
		const nestedFile = path.join(nestedStore.dir, "nested.jsonl");
		const nested = await SessionManager.openNestedManaged(nestedFile, nestedDestination, nestedStore);
		const expectedCacheRoot = path.join(customAgentDir, "resident-cache");
		try {
			appendLargeUserText(nested, `nested profile ${"n".repeat(4096)}`);
			await nested.flush();

			expect(residentInstanceDirs(expectedCacheRoot)).toHaveLength(1);
			expect(fs.existsSync(path.join(nestedStore.dir, "resident-cache"))).toBe(false);
		} finally {
			await nested.close().catch(() => {});
		}
	});

	it.skipIf(process.platform === "win32")(
		"uses the win32 memory gate before any resident-cache directory creation",
		async () => {
			const root = makeTempDir();
			const cwd = path.join(root, "workspace");
			ensurePrivateDirectory(cwd);
			const cacheRoot = getResidentCacheRootDir(getAgentDir());
			const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
			const mkdirSync = vi.spyOn(fs, "mkdirSync");
			const mkdtempSync = vi.spyOn(fs, "mkdtempSync");
			let manager: SessionManager | undefined;
			try {
				Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
				manager = SessionManager.create(cwd, path.join(root, "sessions"));
				appendLargeUserText(manager, `win32 memory gate ${"w".repeat(4096)}`);
			} finally {
				if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
			}

			try {
				expect(manager).toBeDefined();
				expect(manager!.getObservabilityStatsForTests().residentCacheWin32FallbackCount).toBe(1);
				expect(fs.existsSync(cacheRoot)).toBe(false);
				expect(mkdirSync.mock.calls.some(([directory]) => isWithin(cacheRoot, String(directory)))).toBe(false);
				expect(mkdtempSync.mock.calls.some(([prefix]) => isWithin(cacheRoot, String(prefix)))).toBe(false);
			} finally {
				await manager?.close().catch(() => {});
			}
		},
	);
});
