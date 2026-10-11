import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { verifyOwnerOnlyPathSecurity } from "@gajae-code/natives";
import { getAgentDir, setAgentDir, TempDir } from "@gajae-code/utils";

const posix = process.platform !== "win32";

function aclToolAvailable(): boolean {
	if (process.platform === "darwin" || process.platform === "win32") return true;
	if (process.platform !== "linux") return false;
	const result = spawnSync("setfacl", ["--version"], { encoding: "utf8" });
	return (result.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
}

function permissionBits(filePath: string): number {
	const stat = fs.lstatSync(filePath);
	if (!stat.isFile()) throw new Error(`expected a regular file: ${filePath}`);
	return stat.mode & 0o777;
}

async function withPermissiveUmask<T>(run: () => Promise<T>): Promise<T> {
	const previous = process.umask(0o022);
	try {
		return await run();
	} finally {
		process.umask(previous);
	}
}

function installInheritedSharedRead(directory: string): void {
	if (process.platform === "darwin") {
		const result = spawnSync("/bin/chmod", ["+a", "everyone allow read,file_inherit,directory_inherit", directory], {
			encoding: "utf8",
		});
		if (result.status !== 0) throw new Error(`chmod +a failed: ${result.stderr || result.error?.message}`);
		return;
	}
	if (process.platform === "win32") {
		const result = spawnSync("icacls", [directory, "/grant", "*S-1-1-0:(OI)(CI)R"], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`icacls failed: ${result.stderr || result.error?.message}`);
		return;
	}
	if (process.platform === "linux") {
		const result = spawnSync("setfacl", ["-m", "d:o:r", directory], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`setfacl failed: ${result.stderr || result.error?.message}`);
	}
}

function installFileSharedRead(filePath: string): void {
	if (process.platform === "darwin") {
		const result = spawnSync("/bin/chmod", ["+a", "everyone allow read", filePath], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`chmod +a failed: ${result.stderr || result.error?.message}`);
		return;
	}
	if (process.platform === "win32") {
		const result = spawnSync("icacls", [filePath, "/grant", "*S-1-1-0:R"], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`icacls failed: ${result.stderr || result.error?.message}`);
		return;
	}
	if (process.platform === "linux") {
		const result = spawnSync("setfacl", ["-m", "o:r", filePath], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`setfacl failed: ${result.stderr || result.error?.message}`);
	}
}

function expectNativeOwnerOnly(filePath: string): void {
	const verified = verifyOwnerOnlyPathSecurity(filePath, "file");
	expect(verified.ok, verified.ok ? "" : verified.code).toBe(true);
	if (process.platform !== "win32") expect(permissionBits(filePath)).toBe(0o600);
}

async function flushedExplicitSession(root: string, content: string): Promise<SessionManager> {
	const session = SessionManager.create(root, root);
	session.appendMessage({ role: "user", content, timestamp: 1 });
	await session.flush();
	if (!session.getSessionFile()) throw new Error("expected a persisted session file");
	return session;
}

describe("explicit session file mode", () => {
	it("keeps an explicit fork transcript readable by its owner", async () => {
		await withPermissiveUmask(async () => {
			using tempDir = TempDir.createSync("@pi-session-fork-read-");
			const session = await flushedExplicitSession(tempDir.path(), "fork-canary");
			const prepared = await session.prepareFork();
			if (!prepared?.sessionFile) throw new Error("expected a fork transcript");
			try {
				expect(fs.readFileSync(prepared.sessionFile, "utf8")).toContain("fork-canary");
			} finally {
				await session.discardPreparedNewSession(prepared);
				await session.close();
			}
		});
	});

	it.skipIf(!posix)("creates an explicit fork transcript owner-only", async () => {
		await withPermissiveUmask(async () => {
			using tempDir = TempDir.createSync("@pi-session-fork-mode-");
			const session = await flushedExplicitSession(tempDir.path(), "fork-canary");
			const prepared = await session.prepareFork();
			if (!prepared?.sessionFile) throw new Error("expected a fork transcript");
			try {
				expect(fs.readFileSync(prepared.sessionFile, "utf8")).toContain("fork-canary");
				expect(permissionBits(prepared.sessionFile)).toBe(0o600);
			} finally {
				await session.discardPreparedNewSession(prepared);
				await session.close();
			}
		});
	});

	it("keeps an explicit branched session readable by its owner", async () => {
		await withPermissiveUmask(async () => {
			using tempDir = TempDir.createSync("@pi-session-branch-read-");
			const session = SessionManager.create(tempDir.path(), tempDir.path());
			const leafId = session.appendMessage({ role: "user", content: "branch-canary", timestamp: 1 });
			await session.flush();
			const branched = session.createBranchedSession(leafId);
			if (!branched) throw new Error("expected a branched session file");
			expect(fs.readFileSync(branched, "utf8")).toContain("branch-canary");
			await session.close();
		});
	});

	it.skipIf(!posix)("creates an explicit branched session owner-only", async () => {
		await withPermissiveUmask(async () => {
			using tempDir = TempDir.createSync("@pi-session-branch-mode-");
			const session = SessionManager.create(tempDir.path(), tempDir.path());
			const leafId = session.appendMessage({ role: "user", content: "branch-canary", timestamp: 1 });
			await session.flush();
			const branched = session.createBranchedSession(leafId);
			if (!branched) throw new Error("expected a branched session file");
			expect(fs.readFileSync(branched, "utf8")).toContain("branch-canary");
			expect(permissionBits(branched)).toBe(0o600);
			await session.close();
		});
	});

	it("keeps an explicit draft readable by its owner", async () => {
		await withPermissiveUmask(async () => {
			using tempDir = TempDir.createSync("@pi-session-draft-read-");
			const session = await flushedExplicitSession(tempDir.path(), "draft-owner");
			try {
				await session.saveDraft("draft-canary");
				expect(await session.consumeDraft()).toBe("draft-canary");
			} finally {
				await session.close();
			}
		});
	});

	it.skipIf(!posix)("creates an explicit draft owner-only", async () => {
		await withPermissiveUmask(async () => {
			using tempDir = TempDir.createSync("@pi-session-draft-mode-");
			const session = await flushedExplicitSession(tempDir.path(), "draft-owner");
			try {
				await session.saveDraft("draft-canary");
				await session.saveDraft("draft-canary-2");
				const artifactsDir = session.getArtifactsDir();
				if (!artifactsDir) throw new Error("expected an artifacts directory");
				const draftPath = path.join(artifactsDir, "draft.txt");
				expect(fs.readFileSync(draftPath, "utf8")).toBe("draft-canary-2");
				expect(permissionBits(draftPath)).toBe(0o600);
			} finally {
				await session.close();
			}
		});
	});

	it.skipIf(!posix)("keeps the primary explicit transcript owner-only", async () => {
		await withPermissiveUmask(async () => {
			using tempDir = TempDir.createSync("@pi-session-primary-mode-");
			const session = SessionManager.create(tempDir.path(), tempDir.path());
			session.appendMessage({ role: "user", content: "primary-canary", timestamp: 1 });
			await session.saveDraft("keep-primary");
			try {
				const sessionFile = session.getSessionFile();
				if (!sessionFile || !fs.existsSync(sessionFile)) throw new Error("expected a persisted session file");
				expect(fs.readFileSync(sessionFile, "utf8")).toContain("primary-canary");
				expect(permissionBits(sessionFile)).toBe(0o600);
			} finally {
				await session.close();
			}
		});
	});

	it.skipIf(!aclToolAvailable())("creates an explicit fork transcript with native owner-only security", async () => {
		await withPermissiveUmask(async () => {
			using tempDir = TempDir.createSync("@pi-session-fork-acl-");
			installInheritedSharedRead(tempDir.path());
			const session = await flushedExplicitSession(tempDir.path(), "fork-acl");
			const prepared = await session.prepareFork();
			if (!prepared?.sessionFile) throw new Error("expected a fork transcript");
			try {
				expect(fs.readFileSync(prepared.sessionFile, "utf8")).toContain("fork-acl");
				expectNativeOwnerOnly(prepared.sessionFile);
			} finally {
				await session.discardPreparedNewSession(prepared);
				await session.close();
			}
		});
	});

	it.skipIf(!aclToolAvailable())("creates an explicit branched session with native owner-only security", async () => {
		await withPermissiveUmask(async () => {
			using tempDir = TempDir.createSync("@pi-session-branch-acl-");
			installInheritedSharedRead(tempDir.path());
			const session = SessionManager.create(tempDir.path(), tempDir.path());
			const leafId = session.appendMessage({ role: "user", content: "branch-acl", timestamp: 1 });
			await session.flush();
			const branched = session.createBranchedSession(leafId);
			if (!branched) throw new Error("expected a branched session file");
			expect(fs.readFileSync(branched, "utf8")).toContain("branch-acl");
			expectNativeOwnerOnly(branched);
			await session.close();
		});
	});

	it.skipIf(!aclToolAvailable())("creates an explicit draft with native owner-only security", async () => {
		await withPermissiveUmask(async () => {
			using tempDir = TempDir.createSync("@pi-session-draft-acl-");
			const session = await flushedExplicitSession(tempDir.path(), "draft-acl");
			try {
				await session.saveDraft("draft-acl");
				const artifactsDir = session.getArtifactsDir();
				if (!artifactsDir) throw new Error("expected an artifacts directory");
				const draftPath = path.join(artifactsDir, "draft.txt");
				installFileSharedRead(draftPath);
				await session.saveDraft("draft-acl-2");
				expect(fs.readFileSync(draftPath, "utf8")).toBe("draft-acl-2");
				expectNativeOwnerOnly(draftPath);
			} finally {
				await session.close();
			}
		});
	});

	it.skipIf(!posix)("keeps a managed fork transcript owner-only and readable", async () => {
		await withPermissiveUmask(async () => {
			using tempDir = TempDir.createSync("@pi-session-managed-fork-mode-");
			const previousAgentDir = getAgentDir();
			const agentDir = path.join(tempDir.path(), "agent");
			setAgentDir(agentDir);
			try {
				const session = SessionManager.create(tempDir.path());
				session.appendMessage({ role: "user", content: "managed-canary", timestamp: 1 });
				await session.flush();
				const prepared = await session.prepareFork();
				if (!prepared?.sessionFile) throw new Error("expected a managed fork transcript");
				try {
					expect(fs.readFileSync(prepared.sessionFile, "utf8")).toContain("managed-canary");
					expect(permissionBits(prepared.sessionFile)).toBe(0o600);
				} finally {
					await session.discardPreparedNewSession(prepared);
					await session.close();
				}
			} finally {
				setAgentDir(previousAgentDir);
			}
		});
	});
});
