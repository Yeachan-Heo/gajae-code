import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeCheckpoint } from "../../src/continuity/checkpoint";
import { readResumePacket } from "../../src/continuity/resume";
import { parseMemoryDocument } from "../../src/documents/document-parser";
import type { MemoryEnvironment, RepositorySnapshot } from "../../src/env";
import type { CheckpointInput } from "../../src/index";
import { checkpoint as publicCheckpoint } from "../../src/index";
import { resolveReadableResource } from "../../src/resources/resolve-readable-resource";
import { createMemoryRootScaffold } from "../../src/storage/bootstrap-init";

const temporaryParents: string[] = [];
const REPOSITORY: RepositorySnapshot = {
	worktreeRoot: "/workspace/widget",
	commonDir: "/workspace/widget/.git",
	isLinkedWorktree: false,
	remotes: [{ name: "origin", url: "git@github.com:acme/widget.git" }],
};

function environment(memoryRoot: string, sessionId: string | null = "session-1"): MemoryEnvironment {
	return {
		memoryRoot,
		repository: REPOSITORY,
		sessionId,
		now: new Date("2026-07-29T00:00:00.000Z"),
		deterministic: true,
		asOf: "2026-07-29T00:00:00.000Z",
	};
}

async function makeRoot(sessionId = "session-1", createSession = true): Promise<string> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-continuity-"));
	temporaryParents.push(parent);
	const root = path.join(parent, "memory");
	await createMemoryRootScaffold(root);
	if (createSession) {
		const sessionDirectory = path.join(root, "sessions", sessionId);
		await fs.mkdir(sessionDirectory, { mode: 0o700 });
		await fs.chmod(sessionDirectory, 0o700);
	}
	return root;
}

function input(overrides: Partial<CheckpointInput> = {}): CheckpointInput {
	return {
		goal: "Ship checkpoint continuity",
		task: "Implement the M4 core",
		nextSteps: ["Write the checkpoint", "Read the handoff"],
		...overrides,
	};
}

function checkpointPath(root: string, sessionId = "session-1"): string {
	return path.join(root, "sessions", sessionId, "checkpoint.md");
}

async function writeRawCheckpoint(root: string, content: string, sessionId = "session-1"): Promise<void> {
	await fs.writeFile(await checkpointPath(root, sessionId), content, { encoding: "utf8", mode: 0o600 });
}

function malformedCheckpoint(): string {
	return [
		"---",
		"schemaVersion: gajae.memory.document.v1",
		"id: checkpoint-session-1",
		"type: task-state",
		"scope: session",
		"authority: session-observed",
		"volatility: volatile",
		"sensitivity: public-safe",
		"status: active",
		"created: 2026-07-29T00:00:00.000Z",
		"updated: 2026-07-29T00:00:00.000Z",
		"---",
		"# Checkpoint",
		"",
		"## Goal",
		"- goal",
		"",
		"## Task",
		"- task",
		"",
		"## Unexpected",
		"- wrong",
		"",
	].join("\n");
}

afterEach(async () => {
	await Promise.all(temporaryParents.splice(0).map(parent => fs.rm(parent, { recursive: true, force: true })));
});

describe("checkpoint and resume continuity", () => {
	it("round-trips a checkpoint through the policy-checked reader", async () => {
		const root = await makeRoot();
		const env = environment(root);
		const written = await writeCheckpoint(env, input());
		expect(written.ok).toBe(true);
		if (!written.ok) return;
		const resumed = await readResumePacket(env);
		expect(resumed).toEqual({
			ok: true,
			value: {
				schemaVersion: "gajae.memory.handoff.v1",
				sessionId: "session-1",
				goal: "Ship checkpoint continuity",
				task: "Implement the M4 core",
				nextSteps: ["Write the checkpoint", "Read the handoff"],
			},
		});
		expect(written.value.uri).toBe("session://session-1/checkpoint.md");
	});

	it("uses an explicit resume session over the environment session", async () => {
		const sessionId = "resume-session-b";
		const root = await makeRoot(sessionId);
		const written = await writeCheckpoint(environment(root, sessionId), input());
		expect(written.ok).toBe(true);
		if (!written.ok) return;
		const resumed = await readResumePacket(environment(root, "resume-session-a"), { sessionId });
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumed.value.sessionId).toBe(sessionId);
	});

	it("uses an explicit resume session when the environment session is null", async () => {
		const sessionId = "resume-session-explicit";
		const root = await makeRoot(sessionId);
		const written = await writeCheckpoint(environment(root, sessionId), input());
		expect(written.ok).toBe(true);
		if (!written.ok) return;
		const resumed = await readResumePacket(environment(root, null), { sessionId });
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumed.value.sessionId).toBe(sessionId);
	});

	it("fails closed when no resume session is available", async () => {
		const root = await makeRoot();
		const result = await readResumePacket(environment(root, null));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("scope-unresolved");
	});

	it("creates a lazy session directory before publishing the checkpoint", async () => {
		const sessionId = "lazy-checkpoint-session";
		const root = await makeRoot(sessionId, false);
		const result = await writeCheckpoint(environment(root, sessionId), input());
		expect(result.ok).toBe(true);
		const sessionStat = await fs.lstat(path.join(root, "sessions", sessionId));
		expect(sessionStat.isDirectory()).toBe(true);
		expect(sessionStat.isSymbolicLink()).toBe(false);
		expect(sessionStat.mode & 0o777).toBe(0o700);
		const checkpointStat = await fs.stat(checkpointPath(root, sessionId));
		expect(checkpointStat.mode & 0o777).toBe(0o600);
	});

	it("denies symlinked and wrong-mode session directories without writing", async () => {
		const wrongModeSession = "wrong-mode-checkpoint-session";
		const wrongModeRoot = await makeRoot(wrongModeSession);
		await fs.chmod(path.join(wrongModeRoot, "sessions", wrongModeSession), 0o750);
		const wrongMode = await writeCheckpoint(environment(wrongModeRoot, wrongModeSession), input());
		expect(wrongMode.ok).toBe(false);
		expect(
			await fs.lstat(checkpointPath(wrongModeRoot, wrongModeSession)).then(
				() => true,
				() => false,
			),
		).toBe(false);

		const symlinkSession = "symlink-checkpoint-session";
		const symlinkRoot = await makeRoot(symlinkSession, false);
		const outsideParent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-continuity-outside-"));
		temporaryParents.push(outsideParent);
		const outside = path.join(outsideParent, "session");
		await fs.mkdir(outside, { mode: 0o700 });
		await fs.symlink(outside, path.join(symlinkRoot, "sessions", symlinkSession), "dir");
		const symlink = await writeCheckpoint(environment(symlinkRoot, symlinkSession), input());
		expect(symlink.ok).toBe(false);
		expect(
			await fs.lstat(checkpointPath(symlinkRoot, symlinkSession)).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("emits the exact level-2 section set in order", async () => {
		const root = await makeRoot();
		const written = await writeCheckpoint(environment(root), input());
		expect(written.ok).toBe(true);
		const content = await fs.readFile(await checkpointPath(root), "utf8");
		const parsed = parseMemoryDocument({ content, relPath: "sessions/session-1/checkpoint.md" });
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.sections.filter(section => section.level === 2).map(section => section.heading)).toEqual([
			"Goal",
			"Task",
			"Current Branch and Worktree",
			"Completed",
			"Current Blockers",
			"Modified Files",
			"Verification",
			"Pending Decisions",
			"Next Three Steps",
			"Files To Read First",
			"Last Known Good Command",
		]);
	});

	it("keeps repository paths out of checkpoint payloads and receipts", async () => {
		const root = await makeRoot();
		const result = await writeCheckpoint(environment(root), input());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const content = await fs.readFile(await checkpointPath(root), "utf8");
		expect(content).not.toContain(REPOSITORY.worktreeRoot);
		expect(JSON.stringify(result.value)).not.toContain(REPOSITORY.worktreeRoot);
		if (REPOSITORY.commonDir !== null) {
			expect(content).not.toContain(REPOSITORY.commonDir);
			expect(JSON.stringify(result.value)).not.toContain(REPOSITORY.commonDir);
		}
		expect(content).toContain(
			"Worktree: remembered repository state; verify against the current checkout before relying on it",
		);
	});

	it("rejects more than three next steps before writing", async () => {
		const root = await makeRoot();
		const result = await writeCheckpoint(environment(root), input({ nextSteps: ["one", "two", "three", "four"] }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid-input");
	});

	it("returns scope-unresolved when no session id is available", async () => {
		const root = await makeRoot();
		const result = await writeCheckpoint(environment(root, null), input());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("scope-unresolved");
	});

	it("returns not-initialized without touching an absent root", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-continuity-absent-"));
		temporaryParents.push(parent);
		const result = await writeCheckpoint(environment(path.join(parent, "missing")), input());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("not-initialized");
	});

	it("refuses secret content through the checkpoint sensitivity policy", async () => {
		const root = await makeRoot();
		const result = await writeCheckpoint(environment(root), input({ goal: "sk_secret123456789" }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("sensitivity-violation");
	});

	it("returns malformed-document for a malformed checkpoint body", async () => {
		const root = await makeRoot();
		await writeRawCheckpoint(root, malformedCheckpoint());
		const result = await readResumePacket(environment(root));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("malformed-document");
	});

	it("returns malformed-document for reordered checkpoint sections", async () => {
		const root = await makeRoot();
		const written = await writeCheckpoint(environment(root), input());
		expect(written.ok).toBe(true);
		if (!written.ok) return;
		const content = await fs.readFile(await checkpointPath(root), "utf8");
		const reordered = content
			.replace("## Goal", "## __Goal__")
			.replace("## Task", "## Goal")
			.replace("## __Goal__", "## Task");
		await fs.writeFile(await checkpointPath(root), reordered, { encoding: "utf8", mode: 0o600 });
		const result = await readResumePacket(environment(root));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("malformed-document");
	});

	it("returns malformed-document for four next-step entries", async () => {
		const root = await makeRoot();
		const written = await writeCheckpoint(environment(root), input());
		expect(written.ok).toBe(true);
		if (!written.ok) return;
		const content = await fs.readFile(await checkpointPath(root), "utf8");
		const fourSteps = content.replace(
			"\n\n## Files To Read First",
			"\n- Third step\n- Fourth step\n\n## Files To Read First",
		);
		await fs.writeFile(await checkpointPath(root), fourSteps, { encoding: "utf8", mode: 0o600 });
		const result = await readResumePacket(environment(root));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("malformed-document");
	});

	it("does not assert volatile branch or verification details in the handoff", async () => {
		const root = await makeRoot();
		const written = await writeCheckpoint(environment(root), input());
		expect(written.ok).toBe(true);
		const result = await readResumePacket(environment(root));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).not.toHaveProperty("branch");
		expect(result.value).not.toHaveProperty("verification");
	});

	it("is byte-stable for identical deterministic inputs", async () => {
		const firstRoot = await makeRoot();
		const secondRoot = await makeRoot();
		const first = await writeCheckpoint(
			environment(firstRoot),
			input({ constraints: ["Use LF"], decisions: ["Keep M4 narrow"] }),
		);
		const second = await writeCheckpoint(
			environment(secondRoot),
			input({ constraints: ["Use LF"], decisions: ["Keep M4 narrow"] }),
		);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(await fs.readFile(await checkpointPath(firstRoot))).toEqual(
			await fs.readFile(await checkpointPath(secondRoot)),
		);
	});

	it("publishes checkpoint files with mode 0600", async () => {
		const root = await makeRoot();
		const result = await writeCheckpoint(environment(root), input());
		expect(result.ok).toBe(true);
		const stat = await fs.stat(await checkpointPath(root));
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it("returns resource policy denial for a symlinked checkpoint", async () => {
		const root = await makeRoot();
		const written = await writeCheckpoint(environment(root), input());
		expect(written.ok).toBe(true);
		if (!written.ok) return;
		const content = await fs.readFile(await checkpointPath(root), "utf8");
		const outsideParent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-continuity-resume-outside-"));
		temporaryParents.push(outsideParent);
		const outsideCheckpoint = path.join(outsideParent, "checkpoint.md");
		await fs.writeFile(outsideCheckpoint, content, { encoding: "utf8", mode: 0o600 });
		await fs.rm(await checkpointPath(root));
		await fs.symlink(outsideCheckpoint, await checkpointPath(root), "file");
		const result = await readResumePacket(environment(root));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("policy-denied");
	});

	it("reads through the resource resolver rather than exposing a raw path", async () => {
		const root = await makeRoot();
		await writeCheckpoint(environment(root), input());
		const resource = await resolveReadableResource(environment(root), "session://session-1/checkpoint.md");
		expect(resource.ok).toBe(true);
		if (resource.ok) expect(resource.value.content).toContain("# Checkpoint");
	});
	it("denies a checkpoint when in-store policy disables writes or the checkpoint destination", async () => {
		for (const [label, config] of [
			["writes disabled", "version: 1\nwrite:\n  enabled: false\n"],
			[
				"checkpoint destination excluded",
				"version: 1\nwrite:\n  allowedDestinations: [global-canonical, project-canonical, session, proposal, ledger]\n",
			],
		] as const) {
			const root = await makeRoot();
			await fs.writeFile(path.join(root, "config.yaml"), config, { mode: 0o600 });
			const before = await fs
				.readdir(path.join(root, "sessions"))
				.then(entries => entries.sort())
				.catch(() => []);
			const result = await publicCheckpoint(environment(root, "policy-session"), {
				goal: "g",
				task: "t",
				nextSteps: ["s"],
			});
			expect(result.ok, label).toBe(false);
			if (result.ok) continue;
			expect(result.error.code, label).toBe("policy-denied");
			expect(result.error.exitCode, label).toBe(6);
			// The denial must happen before any store mutation.
			const after = await fs
				.readdir(path.join(root, "sessions"))
				.then(entries => entries.sort())
				.catch(() => []);
			expect(after, label).toEqual(before);
		}
	});
});
