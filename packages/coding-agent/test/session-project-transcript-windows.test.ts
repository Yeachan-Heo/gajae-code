import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	isProjectSessionTranscriptPath,
	listProjectSessionTranscriptFiles,
	readAuthorizedProjectSessionTranscript,
	SessionManager,
} from "../src/session/session-manager";

let cwd: string;
let projectGjcDir: string;
let managedAgentDir: string;
let managedCandidatePath: string;
let managedTranscript: string;

beforeEach(async () => {
	cwd = fs.realpathSync(await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-project-transcript-")));
	managedAgentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-project-transcript-agent-"));
	projectGjcDir = path.join(cwd, ".gjc");

	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, managedAgentDir));
	await manager.ensureOnDisk();
	manager.appendMessage({ role: "user", content: "managed project transcript", timestamp: 1 });
	await manager.flush();
	managedCandidatePath = manager.getSessionFile()!;
	managedTranscript = await fs.promises.readFile(managedCandidatePath, "utf8");
	await manager.close();
});

afterEach(async () => {
	await fs.promises.rm(cwd, { recursive: true, force: true });
	await fs.promises.rm(managedAgentDir, { recursive: true, force: true });
});

describe("project transcript managed-scope authorization", () => {
	it("discovers and reads a genuine SessionManager-created managed candidate", () => {
		const limit = Buffer.byteLength(managedTranscript);
		expect(listProjectSessionTranscriptFiles(cwd, managedAgentDir)).toEqual([managedCandidatePath]);
		expect(isProjectSessionTranscriptPath(projectGjcDir, managedCandidatePath, managedAgentDir)).toBe(true);
		expect(
			readAuthorizedProjectSessionTranscript(
				projectGjcDir,
				managedCandidatePath,
				limit,
				managedAgentDir,
			)?.toString(),
		).toBe(managedTranscript);
	});

	it("rejects forged project files from discovery, read, deletion, and picker starring", async () => {
		const forgedPaths = [
			path.join(projectGjcDir, "forged.jsonl"),
			path.join(projectGjcDir, "sessions", "direct", "forged.jsonl"),
			path.join(projectGjcDir, "sessions", "legacy-scope", "forged.jsonl"),
			path.join(projectGjcDir, "sessions", "v2-forged-scope", "forged.jsonl"),
			path.join(projectGjcDir, "agent-session", "forged.jsonl"),
		];
		for (const filePath of forgedPaths) {
			await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
			await fs.promises.writeFile(filePath, managedTranscript);
		}

		const limit = Buffer.byteLength(managedTranscript);
		const genuineSession = (await SessionManager.listManagedForResumePickerReadOnly(cwd, managedAgentDir)).find(
			session => session.path === managedCandidatePath,
		);
		expect(genuineSession).toBeDefined();
		expect(listProjectSessionTranscriptFiles(cwd, managedAgentDir)).toEqual([managedCandidatePath]);
		for (const filePath of forgedPaths) {
			expect(isProjectSessionTranscriptPath(projectGjcDir, filePath, managedAgentDir)).toBe(false);
			expect(listProjectSessionTranscriptFiles(cwd, managedAgentDir)).not.toContain(filePath);
			expect(
				readAuthorizedProjectSessionTranscript(projectGjcDir, filePath, limit, managedAgentDir),
			).toBeUndefined();
			await expect(SessionManager.deleteManagedCandidate(filePath)).rejects.toThrow("authorized managed candidate");
			await expect(
				SessionManager.setSessionStarredForPicker({ ...genuineSession!, path: filePath }, true),
			).rejects.toThrow("authorized managed candidate");
		}
	});

	it("preserves transcript path containment and bounded-read checks", async () => {
		const privateFile = path.join(projectGjcDir, "private.jsonl");
		const nestedFile = path.join(projectGjcDir, "nested", "sessions", "events.jsonl");
		await fs.promises.mkdir(path.dirname(nestedFile), { recursive: true });
		await fs.promises.writeFile(privateFile, managedTranscript);
		await fs.promises.writeFile(nestedFile, managedTranscript);

		expect(
			readAuthorizedProjectSessionTranscript(projectGjcDir, path.join(cwd, "outside.jsonl"), 4096),
		).toBeUndefined();
		expect(readAuthorizedProjectSessionTranscript(projectGjcDir, privateFile, 4096)).toBeUndefined();
		expect(readAuthorizedProjectSessionTranscript(projectGjcDir, nestedFile, 4096)).toBeUndefined();
		expect(
			readAuthorizedProjectSessionTranscript(
				projectGjcDir,
				managedCandidatePath,
				Buffer.byteLength(managedTranscript) - 1,
			),
		).toBeUndefined();
		for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
			expect(readAuthorizedProjectSessionTranscript(projectGjcDir, managedCandidatePath, limit)).toBeUndefined();
		}
	});

	it("preserves explicitly configured session-directory listing and star authority", async () => {
		const explicitSessionDir = path.join(projectGjcDir, "sessions", "explicit");
		const explicitManager = SessionManager.create(cwd, explicitSessionDir);
		try {
			await explicitManager.ensureOnDisk();
			explicitManager.appendMessage({ role: "user", content: "explicit transcript", timestamp: 2 });
			await explicitManager.flush();
			const explicitSessionFile = explicitManager.getSessionFile();
			if (!explicitSessionFile) throw new Error("explicit session manager did not persist a transcript");
			const [session] = await SessionManager.listForResumePickerReadOnly(cwd, explicitSessionDir);
			expect(session?.path).toBe(explicitSessionFile);
			await SessionManager.setSessionStarredForPicker(session!, true, explicitSessionDir);
			expect((await SessionManager.listForResumePickerReadOnly(cwd, explicitSessionDir))[0]?.starred).toBe(true);
		} finally {
			await explicitManager.close();
		}
	});
});
