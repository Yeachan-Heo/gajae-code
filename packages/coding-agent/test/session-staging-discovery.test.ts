import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	listProjectSessionTranscriptFiles,
	resolveResumableSession,
	SessionManager,
} from "../src/session/session-manager";
import { isStagedSessionPath, SESSION_STAGING_DIRNAME } from "../src/session/session-staging-paths";

async function makeTranscript(filePath: string, cwd: string, id: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(
		filePath,
		`${JSON.stringify({ type: "session", version: 5, id, timestamp: new Date().toISOString(), cwd })}\n`,
	);
}

describe("staged session discovery exclusion", () => {
	it("discovers only validated user-managed candidates while preserving explicit-directory authority", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "gjc-discovery-cwd-"));
		const agentDir = await mkdtemp(path.join(tmpdir(), "gjc-discovery-agent-"));
		const scope = path.join(cwd, ".gjc", "sessions", "scope");
		const staged = path.join(scope, SESSION_STAGING_DIRNAME, "attempt.jsonl");
		const sibling = path.join(scope, "sibling.jsonl");
		await makeTranscript(staged, cwd, "staged-id");
		await makeTranscript(sibling, cwd, "sibling-id");
		const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		try {
			await manager.ensureOnDisk();
			manager.appendMessage({ role: "user", content: "managed picker session", timestamp: 1 });
			await manager.flush();
			const genuine = manager.getSessionFile()!;
			const sessions = await SessionManager.listManagedForResumePickerReadOnly(cwd, agentDir);
			expect(sessions.map(session => session.path)).toContain(genuine);
			expect(sessions.map(session => session.path)).not.toContain(sibling);
			expect(sessions.map(session => session.path)).not.toContain(staged);
			expect(listProjectSessionTranscriptFiles(cwd, agentDir)).toEqual([genuine]);
			const resumed = await resolveResumableSession(manager.getSessionId(), cwd, undefined, undefined, agentDir);
			expect(resumed?.session.path).toBe(genuine);
			const explicitResumed = await resolveResumableSession("sibling-id", cwd, scope);
			expect(explicitResumed?.session.path).toBe(sibling);
			const stagedResume = await resolveResumableSession("staged-id", cwd, undefined, undefined, agentDir);
			expect(stagedResume).toBeUndefined();
		} finally {
			await manager.close();
			await rm(cwd, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("recognizes staging segments independently of session-layer imports", async () => {
		const stagedPath = path.join("/tmp", "agent-session", SESSION_STAGING_DIRNAME, "attempt.jsonl");
		expect(isStagedSessionPath(stagedPath)).toBe(true);
		expect(isStagedSessionPath(path.join("/tmp", "agent-session", "sibling.jsonl"))).toBe(false);
		expect(isStagedSessionPath(path.join("/srv", SESSION_STAGING_DIRNAME, "gjc-sessions", "session.jsonl"))).toBe(
			false,
		);
		const source = await readFile(new URL("../src/session/session-staging-paths.ts", import.meta.url), "utf8");
		expect(source).not.toContain("session-manager");
		expect(source).not.toContain("./artifacts");
	});

	it("excludes forged project paths from managed discovery and staging from explicit/managed readers", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "gjc-four-reader-cwd-"));
		const projectAgentDir = await mkdtemp(path.join(tmpdir(), "gjc-four-reader-project-agent-"));
		const projectGjcDir = path.join(cwd, ".gjc");
		const projectScope = path.join(cwd, ".gjc", "sessions", "cwd-scope");
		const agentSessionScope = path.join(cwd, ".gjc", "agent-session");
		const rootForged = path.join(projectGjcDir, "forged.jsonl");
		const sessionRootForged = path.join(projectGjcDir, "sessions", "forged.jsonl");
		const legacyForged = path.join(projectGjcDir, "sessions", "legacy-scope", "forged.jsonl");
		const projectStaged = path.join(projectScope, SESSION_STAGING_DIRNAME, "project-staged.jsonl");
		const agentSessionStaged = path.join(agentSessionScope, SESSION_STAGING_DIRNAME, "agent-staged.jsonl");
		const projectSibling = path.join(projectScope, "project-sibling.jsonl");
		const agentSessionSibling = path.join(agentSessionScope, "agent-sibling.jsonl");
		await makeTranscript(rootForged, cwd, "root-forged-id");
		await makeTranscript(sessionRootForged, cwd, "session-root-forged-id");
		await makeTranscript(legacyForged, cwd, "legacy-forged-id");
		await makeTranscript(projectStaged, cwd, "project-staged-id");
		await makeTranscript(agentSessionStaged, cwd, "agent-staged-id");
		await makeTranscript(projectSibling, cwd, "project-sibling-id");
		await makeTranscript(agentSessionSibling, cwd, "agent-sibling-id");
		const projectManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, projectAgentDir));
		try {
			await projectManager.ensureOnDisk();
			projectManager.appendMessage({ role: "user", content: "managed project session", timestamp: 1 });
			await projectManager.flush();
			const genuine = projectManager.getSessionFile()!;

			// Reader 1: project discovery accepts only the user's validated managed scope.
			const walked = listProjectSessionTranscriptFiles(cwd, projectAgentDir);
			expect(walked).toEqual([genuine]);
			for (const forged of [rootForged, sessionRootForged, legacyForged, projectSibling, agentSessionSibling])
				expect(walked).not.toContain(forged);
			expect(walked).not.toContain(projectStaged);
			expect(walked).not.toContain(agentSessionStaged);

			// Reader 2: an explicitly configured directory retains its separate authority path.
			const projectPicker = await SessionManager.listForResumePickerReadOnly(cwd, projectScope);
			expect(projectPicker.map(session => session.id)).toEqual(["project-sibling-id"]);
			const agentSessionPicker = await SessionManager.listForResumePickerReadOnly(cwd, agentSessionScope);
			expect(agentSessionPicker.map(session => session.id)).toEqual(["agent-sibling-id"]);
		} finally {
			await projectManager.close();
			await rm(cwd, { recursive: true, force: true });
			await rm(projectAgentDir, { recursive: true, force: true });
		}

		// Reader 3: managed picker/inventory must reject a managed .staging child.
		const managedCwd = await mkdtemp(path.join(tmpdir(), "gjc-four-reader-managed-cwd-"));
		const managedAgentDir = await mkdtemp(path.join(tmpdir(), "gjc-four-reader-managed-agent-"));
		const managedDestination = SessionManager.managedDestination(managedCwd, managedAgentDir);
		const managedParent = SessionManager.create(managedCwd, managedDestination);
		try {
			await managedParent.flush();
			const managedStaged = path.join(managedDestination.directory, SESSION_STAGING_DIRNAME, "managed-staged.jsonl");
			await makeTranscript(managedStaged, managedCwd, "managed-staged-id");
			const managedPicker = await SessionManager.listManagedForResumePickerReadOnly(managedCwd, managedAgentDir);
			expect(managedPicker.map(session => session.id)).not.toContain("managed-staged-id");

			// Reader 4: global managed inventory and --continue resolution both reject it.
			const managedInventory = await SessionManager.listAll(undefined, managedAgentDir);
			expect(managedInventory.map(session => session.id)).not.toContain("managed-staged-id");
			const stagedContinue = await resolveResumableSession(
				"managed-staged-id",
				managedCwd,
				undefined,
				undefined,
				managedAgentDir,
			);
			expect(stagedContinue).toBeUndefined();
			const localContinue = await resolveResumableSession("project-staged-id", cwd, projectScope);
			expect(localContinue).toBeUndefined();
		} finally {
			await managedParent.close();
			await rm(managedCwd, { recursive: true, force: true });
			await rm(managedAgentDir, { recursive: true, force: true });
		}
	});
});
