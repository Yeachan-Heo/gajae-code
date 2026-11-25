/**
 * A strict-open failure reaches callers as a typed, operator-actionable error.
 *
 * `SessionManager.open` turns every strict failure into an error: the typed class for an
 * actionable reason, otherwise `Could not open session: <reason>`. `continueRecent`
 * throws the same typed classes, but skips a candidate whose failure is not actionable
 * and starts a fresh session instead.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	SessionArtifactCapacityError,
	SessionContextTooLargeError,
	SessionManager,
	SessionMigrationPolicyError,
	SessionTranscriptOversizedError,
	type StrictSessionOpenFailure,
} from "@gajae-code/coding-agent/session/session-manager";
import { SessionMigrationBusyError } from "../src/session/internal/session-open-errors";

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

function fixture(): { cwd: string; agentDir: string; file: string } {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-strict-open-map-")));
	roots.push(root);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	const transcripts = path.join(root, "transcripts");
	for (const dir of [cwd, agentDir, transcripts]) fs.mkdirSync(dir, { mode: 0o700 });
	const file = path.join(transcripts, "session.jsonl");
	const header = { type: "session", id: "strict-open-map", timestamp: new Date(0).toISOString(), cwd, version: 5 };
	const message = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: "hello", timestamp: 0 },
	};
	fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`, { mode: 0o600 });
	return { cwd, agentDir, file };
}

async function managedCandidate(cwd: string, agentDir: string): Promise<SessionManager> {
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "reply" }],
		api: "openai-completions",
		provider: "fixture",
		model: "fixture-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await manager.flush();
	return manager;
}

const TYPED: ReadonlyArray<[StrictSessionOpenFailure, new (...args: never[]) => Error]> = [
	[{ kind: "error", reason: "legacy_migration_disabled" }, SessionMigrationPolicyError],
	[{ kind: "error", reason: "artifact_capacity_exceeded", message: "too many" }, SessionArtifactCapacityError],
	[{ kind: "error", reason: "oversized", size: 7 }, SessionTranscriptOversizedError],
	[{ kind: "error", reason: "context_too_large", size: 9 }, SessionContextTooLargeError],
	[{ kind: "error", reason: "migration_busy" }, SessionMigrationBusyError],
];

describe("SessionManager.open strict failure mapping", () => {
	for (const [failure, ErrorClass] of TYPED) {
		it(`maps ${failure.reason} to ${ErrorClass.name}`, async () => {
			const { cwd, agentDir, file } = fixture();
			const strict = vi.spyOn(SessionManager, "openExistingStrict").mockResolvedValue(failure);
			const error = await SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir)).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(strict).toHaveBeenCalledTimes(1);
			expect(error).toBeInstanceOf(ErrorClass);
		});
	}

	it("keeps the artifact-capacity message and the oversized size", async () => {
		const { cwd, agentDir, file } = fixture();
		const destination = SessionManager.managedDestination(cwd, agentDir);
		vi.spyOn(SessionManager, "openExistingStrict").mockResolvedValueOnce({
			kind: "error",
			reason: "artifact_capacity_exceeded",
			message: "Artifacts exceed 3 files.",
		});
		await expect(SessionManager.open(file, destination)).rejects.toThrow("Artifacts exceed 3 files.");
		vi.spyOn(SessionManager, "openExistingStrict").mockResolvedValueOnce({
			kind: "error",
			reason: "artifact_capacity_exceeded",
		});
		await expect(SessionManager.open(file, destination)).rejects.toThrow(
			"Session artifacts exceed the migration capacity.",
		);
	});

	it("reports any other reason as a generic open error naming it", async () => {
		const { cwd, agentDir, file } = fixture();
		vi.spyOn(SessionManager, "openExistingStrict").mockResolvedValue({ kind: "error", reason: "identity-mismatch" });
		await expect(SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir))).rejects.toThrow(
			"Could not open session: identity-mismatch",
		);
	});
});

describe("SessionManager.continueRecent strict failure mapping", () => {
	for (const [failure, ErrorClass] of TYPED) {
		it(`throws ${ErrorClass.name} for ${failure.reason}`, async () => {
			const { cwd, agentDir } = fixture();
			const candidate = await managedCandidate(cwd, agentDir);
			await candidate.close();
			const strict = vi.spyOn(SessionManager, "openExistingStrict").mockResolvedValue(failure);
			const error = await SessionManager.continueRecent(cwd, SessionManager.managedDestination(cwd, agentDir)).then(
				manager => {
					managers.push(manager);
					return undefined;
				},
				(caught: unknown) => caught,
			);
			expect(strict).toHaveBeenCalled();
			expect(error).toBeInstanceOf(ErrorClass);
		});
	}

	it("skips a candidate with a non-actionable failure and starts a fresh session", async () => {
		const { cwd, agentDir } = fixture();
		const candidate = await managedCandidate(cwd, agentDir);
		const candidateId = candidate.getSessionId();
		await candidate.close();
		const strict = vi
			.spyOn(SessionManager, "openExistingStrict")
			.mockResolvedValue({ kind: "error", reason: "identity-mismatch" });
		const manager = await SessionManager.continueRecent(cwd, SessionManager.managedDestination(cwd, agentDir));
		managers.push(manager);
		expect(strict).toHaveBeenCalled();
		expect(manager.getSessionId()).not.toBe(candidateId);
		expect(manager.getEntries()).toEqual([]);
	});
});
