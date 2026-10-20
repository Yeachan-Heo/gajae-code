import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@gajae-code/ai";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as git from "@gajae-code/coding-agent/utils/git";
import { getAgentDir, getResidentCacheRootDir, setAgentDir } from "@gajae-code/utils";

const PROPERTY_SEED = 5180518;
const PROPERTY_INPUTS = 64;
const originalAgentDir = getAgentDir();
const envKeys = [
	"GJC_CODING_AGENT_DIR",
	"GJC_CONFIG_DIR",
	"PI_CONFIG_DIR",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
] as const;
const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));
const tempDirs: string[] = [];

afterEach(async () => {
	restoreEnv();
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function restoreEnv(): void {
	for (const key of envKeys) {
		const value = originalEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	setAgentDir(originalAgentDir);
	const override = originalEnv.get("GJC_CODING_AGENT_DIR");
	if (override === undefined) delete process.env.GJC_CODING_AGENT_DIR;
	else process.env.GJC_CODING_AGENT_DIR = override;
}

function makeTemp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function ensurePrivate(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function toolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-resident-worktree",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function treeHas(root: string, needle: string): boolean {
	if (!fs.existsSync(root)) return false;
	const target = Buffer.from(needle);
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
			continue;
		}
		if (!stat.isFile() || stat.size > 2_000_000) continue;
		if (fs.readFileSync(current).includes(target)) return true;
	}
	return false;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

const ASSISTANT_CANARY = `sk-live-CANARY518-assistant-${"A".repeat(1200)}`;
const TOOL_CANARY = `sk-live-CANARY518-tool-${"T".repeat(1200)}`;

function useDefaultProfile(): void {
	delete process.env.GJC_CONFIG_DIR;
	delete process.env.PI_CONFIG_DIR;
	delete process.env.GJC_CODING_AGENT_DIR;
	setAgentDir(path.join(os.homedir(), ".gjc", "agent"));
}

async function persistLargeOutput(cwd: string, sessionDir: string): Promise<SessionManager> {
	ensurePrivate(cwd);
	ensurePrivate(sessionDir);
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage(assistantMessage(ASSISTANT_CANARY));
	manager.appendMessage(toolResult(TOOL_CANARY));
	await manager.ensureOnDisk();
	await manager.flush();
	return manager;
}

describe.skipIf(process.platform === "win32")("resident text cache inside a git worktree", () => {
	it("still writes long assistant and tool text when the cache root is outside a worktree", async () => {
		const root = makeTemp("gjc-resident-allowed-");
		const xdg = path.join(root, "xdg-cache");
		ensurePrivate(path.join(xdg, "gjc"));
		process.env.XDG_CACHE_HOME = xdg;
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		useDefaultProfile();
		const cacheRoot = getResidentCacheRootDir(getAgentDir());
		expect(git.repo.resolveSync(cacheRoot)).toBeNull();
		const manager = await persistLargeOutput(path.join(root, "project"), path.join(root, "sessions"));
		try {
			const cacheDir = manager.residentTextCacheDirForTests();
			expect(cacheDir).toBeString();
			expect(cacheDir?.startsWith(cacheRoot)).toBe(true);
			expect(treeHas(cacheDir ?? cacheRoot, ASSISTANT_CANARY)).toBe(true);
			expect(treeHas(cacheDir ?? cacheRoot, TOOL_CANARY)).toBe(true);
			expect(JSON.stringify(manager.getEntries())).toContain(ASSISTANT_CANARY);
			expect(manager.getObservabilityStatsForTests().residentCacheAdoptFallbackCount).toBe(0);
		} finally {
			await manager.close().catch(() => {});
		}
	});

	it("does not write assistant or tool text into a worktree when XDG cache points there", async () => {
		const root = makeTemp("gjc-resident-xdg-");
		const repo = path.join(root, "repo");
		ensurePrivate(path.join(repo, ".git"));
		const xdg = path.join(repo, ".cache");
		ensurePrivate(path.join(xdg, "gjc"));
		process.env.XDG_CACHE_HOME = xdg;
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		useDefaultProfile();
		const cacheRoot = getResidentCacheRootDir(getAgentDir());
		expect(cacheRoot).toBe(path.join(xdg, "gjc", "resident-cache"));
		expect(git.repo.resolveSync(cacheRoot)?.repoRoot).toBe(repo);
		const manager = await persistLargeOutput(path.join(root, "project"), path.join(root, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		expect(sessionFile.startsWith(repo)).toBe(false);
		try {
			expect(manager.residentTextCacheDirForTests()).toBeUndefined();
			expect(treeHas(repo, ASSISTANT_CANARY)).toBe(false);
			expect(treeHas(repo, TOOL_CANARY)).toBe(false);
			expect(JSON.stringify(manager.getEntries())).toContain(ASSISTANT_CANARY);
			expect(JSON.stringify(manager.getEntries())).toContain(TOOL_CANARY);
			expect(manager.getObservabilityStatsForTests().residentCacheAdoptFallbackCount).toBeGreaterThan(0);
		} finally {
			await manager.close().catch(() => {});
		}
		const reopened = await SessionManager.open(sessionFile);
		try {
			expect(reopened.residentTextCacheDirForTests()).toBeUndefined();
			expect(JSON.stringify(reopened.getEntries())).toContain(ASSISTANT_CANARY);
			expect(JSON.stringify(reopened.getEntries())).toContain(TOOL_CANARY);
			expect(treeHas(repo, ASSISTANT_CANARY)).toBe(false);
		} finally {
			await reopened.close().catch(() => {});
		}
	});

	it("does not write assistant or tool text when the agent dir is inside a worktree", async () => {
		const root = makeTemp("gjc-resident-agent-");
		const repo = path.join(root, "repo");
		const agentDir = path.join(repo, ".gjc-agent");
		ensurePrivate(path.join(repo, ".git"));
		ensurePrivate(agentDir);
		delete process.env.XDG_CACHE_HOME;
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		delete process.env.GJC_CONFIG_DIR;
		delete process.env.PI_CONFIG_DIR;
		setAgentDir(agentDir);
		const cacheRoot = getResidentCacheRootDir(agentDir);
		expect(cacheRoot).toBe(path.join(agentDir, "resident-cache"));
		const manager = await persistLargeOutput(path.join(root, "project"), path.join(root, "sessions"));
		try {
			expect(manager.residentTextCacheDirForTests()).toBeUndefined();
			expect(treeHas(repo, ASSISTANT_CANARY)).toBe(false);
			expect(treeHas(repo, TOOL_CANARY)).toBe(false);
			expect(JSON.stringify(manager.getEntries())).toContain(TOOL_CANARY);
		} finally {
			await manager.close().catch(() => {});
		}
	});

	it("does not write assistant or tool text when an outside symlink points the cache into a worktree", async () => {
		const root = makeTemp("gjc-resident-alias-in-");
		const repo = path.join(root, "repo");
		const inside = path.join(repo, "cache");
		ensurePrivate(repo);
		fs.mkdirSync(path.join(repo, ".git"));
		ensurePrivate(inside);
		const alias = path.join(root, "alias");
		fs.symlinkSync(inside, alias);
		delete process.env.XDG_CACHE_HOME;
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		delete process.env.GJC_CONFIG_DIR;
		delete process.env.PI_CONFIG_DIR;
		setAgentDir(path.join(alias, "agent"));
		const manager = await persistLargeOutput(path.join(root, "project"), path.join(root, "sessions"));
		try {
			expect(manager.residentTextCacheDirForTests()).toBeUndefined();
			expect(treeHas(repo, ASSISTANT_CANARY)).toBe(false);
			expect(treeHas(repo, TOOL_CANARY)).toBe(false);
			expect(JSON.stringify(manager.getEntries())).toContain(ASSISTANT_CANARY);
			expect(JSON.stringify(manager.getEntries())).toContain(TOOL_CANARY);
		} finally {
			await manager.close().catch(() => {});
		}
	});

	it("still writes long assistant and tool text when an outside symlink points at a cache outside a worktree", async () => {
		const root = makeTemp("gjc-resident-alias-out-");
		const realCache = path.join(root, "real-cache");
		ensurePrivate(realCache);
		const alias = path.join(root, "alias");
		fs.symlinkSync(realCache, alias);
		delete process.env.XDG_CACHE_HOME;
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		delete process.env.GJC_CONFIG_DIR;
		delete process.env.PI_CONFIG_DIR;
		setAgentDir(path.join(alias, "agent"));
		expect(git.repo.resolveSync(fs.realpathSync(alias))).toBeNull();
		const manager = await persistLargeOutput(path.join(root, "project"), path.join(root, "sessions"));
		try {
			const cacheDir = manager.residentTextCacheDirForTests();
			expect(cacheDir).toBeString();
			expect(treeHas(fs.realpathSync(cacheDir ?? realCache), ASSISTANT_CANARY)).toBe(true);
			expect(treeHas(fs.realpathSync(cacheDir ?? realCache), TOOL_CANARY)).toBe(true);
			expect(git.repo.resolveSync(fs.realpathSync(cacheDir ?? realCache))).toBeNull();
		} finally {
			await manager.close().catch(() => {});
		}
	});
});

describe.skipIf(process.platform === "win32")("resident text cache path spelling", () => {
	const varPathIsSymlink = (() => {
		try {
			return fs.lstatSync("/var").isSymbolicLink();
		} catch {
			return false;
		}
	})();

	it.skipIf(!varPathIsSymlink)(
		"still writes long assistant and tool text through the macOS /var symlink",
		async () => {
			const varPath = "/var";
			const real = fs.realpathSync(varPath);
			const root = makeTemp("gjc-resident-var-");
			if (!root.startsWith(real)) throw new Error("temp dir is not under the /var target");
			const spelled = path.join(varPath, path.relative(real, root), "agent");
			delete process.env.XDG_CACHE_HOME;
			delete process.env.XDG_DATA_HOME;
			delete process.env.XDG_STATE_HOME;
			delete process.env.GJC_CONFIG_DIR;
			delete process.env.PI_CONFIG_DIR;
			setAgentDir(spelled);
			const manager = await persistLargeOutput(path.join(root, "project"), path.join(root, "sessions"));
			try {
				const cacheDir = manager.residentTextCacheDirForTests();
				expect(cacheDir).toBeString();
				expect(treeHas(fs.realpathSync(cacheDir ?? spelled), ASSISTANT_CANARY)).toBe(true);
				expect(git.repo.resolveSync(fs.realpathSync(cacheDir ?? spelled))).toBeNull();
			} finally {
				await manager.close().catch(() => {});
			}
		},
	);

	it("uses memory when more than 64 missing ancestors hide the cache root", async () => {
		const root = makeTemp("gjc-resident-deep-");
		const segments = Array.from({ length: 70 }, () => "p");
		const agentDir = path.join(root, ...segments, "agent");
		delete process.env.XDG_CACHE_HOME;
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		delete process.env.GJC_CONFIG_DIR;
		delete process.env.PI_CONFIG_DIR;
		setAgentDir(agentDir);
		const manager = await persistLargeOutput(path.join(root, "project"), path.join(root, "sessions"));
		try {
			expect(manager.residentTextCacheDirForTests()).toBeUndefined();
			expect(JSON.stringify(manager.getEntries())).toContain(ASSISTANT_CANARY);
			expect(fs.existsSync(path.join(agentDir, "resident-cache"))).toBe(false);
		} finally {
			await manager.close().catch(() => {});
		}
	});
});

describe("residentTextCacheRootAllowsDisk", () => {
	it(`property: residentTextCacheRootAllowsDisk, seed ${PROPERTY_SEED}, ${PROPERTY_INPUTS} inputs`, async () => {
		const loaded = await import("@gajae-code/coding-agent/session/session-manager");
		const allowsDisk = loaded.residentTextCacheRootAllowsDisk;
		expect(typeof allowsDisk).toBe("function");
		const parent = makeTemp("gjc-resident-property-");
		expect(git.repo.resolveSync(parent)).toBeNull();
		const repo = path.join(parent, "repo");
		const plain = path.join(parent, "plain");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		fs.mkdirSync(plain);
		const random = mulberry32(PROPERTY_SEED);
		const alphabet = ["aa", "bb", "cc", "dd", "ee", "ff"];
		for (let index = 0; index < PROPERTY_INPUTS; index++) {
			const depth = 1 + Math.floor(random() * 4);
			const parts: string[] = [];
			for (let level = 0; level < depth; level++) {
				parts.push(`${alphabet[Math.floor(random() * alphabet.length)]}${index.toString(36)}`);
			}
			const relative = path.join(...parts);
			const inside = path.join(repo, relative);
			const outside = path.join(plain, relative);
			expect(allowsDisk(inside)).toBe(false);
			expect(allowsDisk(inside)).toBe(allowsDisk(path.join(inside, "child")));
			expect(allowsDisk(outside)).toBe(true);
			expect(allowsDisk(outside)).toBe(allowsDisk(outside));
		}
		const linked = path.join(parent, "linked");
		const gitdir = path.join(parent, "real-gitdir");
		fs.mkdirSync(linked);
		fs.mkdirSync(gitdir);
		fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${gitdir}\n`);
		expect(allowsDisk(path.join(linked, "resident-cache"))).toBe(false);
		const bogus = path.join(parent, "bogus");
		fs.mkdirSync(bogus);
		fs.writeFileSync(path.join(bogus, ".git"), "not-a-gitdir\n");
		expect(allowsDisk(path.join(bogus, "resident-cache"))).toBe(true);
		const occupied = path.join(plain, "occupied-root");
		fs.mkdirSync(occupied);
		fs.writeFileSync(path.join(occupied, "resident-cache"), "not-a-directory");
		expect(allowsDisk(path.join(occupied, "resident-cache"))).toBe(true);
		fs.writeFileSync(path.join(repo, "occupied-root"), "not-a-directory");
		expect(allowsDisk(path.join(repo, "occupied-root"))).toBe(false);
		const aliasIn = path.join(parent, "alias-in");
		fs.symlinkSync(repo, aliasIn);
		expect(allowsDisk(path.join(aliasIn, "resident-cache"))).toBe(false);
		expect(allowsDisk(path.join(aliasIn, "missing", "resident-cache"))).toBe(false);
		const outsideTarget = path.join(parent, "outside-target");
		fs.mkdirSync(outsideTarget);
		const aliasOut = path.join(parent, "alias-out");
		fs.symlinkSync(outsideTarget, aliasOut);
		expect(allowsDisk(path.join(aliasOut, "resident-cache"))).toBe(true);
		const trailed = path.join(plain, "trailed");
		expect(allowsDisk(trailed + path.sep)).toBe(allowsDisk(trailed));
		expect(allowsDisk(path.parse(parent).root)).toBe(true);
		const deep = path.join(parent, ...Array.from({ length: 70 }, () => "q"));
		expect(allowsDisk(deep)).toBe(false);
	});
});
