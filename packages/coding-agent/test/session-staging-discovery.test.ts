import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
	it("hides staged project transcripts while retaining a sibling transcript", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "gjc-discovery-cwd-"));
		const agentDir = await mkdtemp(path.join(tmpdir(), "gjc-discovery-agent-"));
		const scope = path.join(cwd, ".gjc", "sessions", "scope");
		const staged = path.join(scope, SESSION_STAGING_DIRNAME, "attempt.jsonl");
		const sibling = path.join(scope, "sibling.jsonl");
		await makeTranscript(staged, cwd, "staged-id");
		await makeTranscript(sibling, cwd, "sibling-id");

		const sessions = await SessionManager.listManagedForResumePickerReadOnly(cwd, agentDir);
		expect(sessions.map(session => session.path)).toContain(sibling);
		expect(sessions.map(session => session.path)).not.toContain(staged);
		const resumed = await resolveResumableSession("sibling-id", cwd, undefined, undefined, agentDir);
		expect(resumed?.session.path).toBe(sibling);
		const stagedResume = await resolveResumableSession("staged-id", cwd, undefined, undefined, agentDir);
		expect(stagedResume).toBeUndefined();
	});

	it("recognizes staging segments independently of session-layer imports", async () => {
		const stagedPath = path.join("/tmp", "agent-session", SESSION_STAGING_DIRNAME, "attempt.jsonl");
		expect(isStagedSessionPath(stagedPath)).toBe(true);
		expect(isStagedSessionPath(path.join("/tmp", "agent-session", "sibling.jsonl"))).toBe(false);
		const source = await readFile(new URL("../src/session/session-staging-paths.ts", import.meta.url), "utf8");
		expect(source).not.toContain("session-manager");
		expect(source).not.toContain("./artifacts");
	});

	it("excludes sessions/<cwd>/.staging and agent-session/.staging from all four readers individually", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "gjc-four-reader-cwd-"));
		const projectScope = path.join(cwd, ".gjc", "sessions", "cwd-scope");
		const agentSessionScope = path.join(cwd, ".gjc", "agent-session");
		const projectStaged = path.join(projectScope, SESSION_STAGING_DIRNAME, "project-staged.jsonl");
		const agentSessionStaged = path.join(agentSessionScope, SESSION_STAGING_DIRNAME, "agent-staged.jsonl");
		const projectSibling = path.join(projectScope, "project-sibling.jsonl");
		const agentSessionSibling = path.join(agentSessionScope, "agent-sibling.jsonl");
		await makeTranscript(projectStaged, cwd, "project-staged-id");
		await makeTranscript(agentSessionStaged, cwd, "agent-staged-id");
		await makeTranscript(projectSibling, cwd, "project-sibling-id");
		await makeTranscript(agentSessionSibling, cwd, "agent-sibling-id");

		// Reader 1: the direct project transcript walk must skip both staging subtrees.
		const walked = listProjectSessionTranscriptFiles(cwd);
		expect(walked).toContain(projectSibling);
		expect(walked).toContain(agentSessionSibling);
		expect(walked).not.toContain(projectStaged);
		expect(walked).not.toContain(agentSessionStaged);

		// Reader 2: explicit resume-picker listing must skip a staged project scope.
		const projectPicker = await SessionManager.listForResumePickerReadOnly(cwd, projectScope);
		expect(projectPicker.map(session => session.id)).toEqual(["project-sibling-id"]);
		const agentSessionPicker = await SessionManager.listForResumePickerReadOnly(cwd, agentSessionScope);
		expect(agentSessionPicker.map(session => session.id)).toEqual(["agent-sibling-id"]);

		// Reader 3: managed picker/inventory must reject a managed .staging child.
		const managedCwd = await mkdtemp(path.join(tmpdir(), "gjc-four-reader-managed-cwd-"));
		const managedAgentDir = await mkdtemp(path.join(tmpdir(), "gjc-four-reader-managed-agent-"));
		const managedDestination = SessionManager.managedDestination(managedCwd, managedAgentDir);
		const managedParent = SessionManager.create(managedCwd, managedDestination);
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
	});
});
