import { describe, expect, it } from "bun:test";
import { taskArtifactOwnerLocatorFromTranscriptBytes } from "../src/session/internal/task-artifact-owner-transcript";
import { ownerIdForSession, type TaskArtifactOwnerLocator } from "../src/session/task-artifact-owner-codec";

const sessionId = "transcript-owner-session";
const initial: TaskArtifactOwnerLocator = {
	schemaVersion: 1,
	ownerId: ownerIdForSession(sessionId),
	directoryDev: "12",
	directoryIno: "34",
};
const updated: TaskArtifactOwnerLocator = { ...initial, directoryIno: "56" };
const encode = (records: readonly unknown[], trailingNewline = true): Uint8Array =>
	new TextEncoder().encode(records.map(record => JSON.stringify(record)).join("\n") + (trailingNewline ? "\n" : ""));
const header = (version = 4) => ({ type: "session", version, id: sessionId, taskArtifactOwner: initial });

describe("task owner transcript locator replay", () => {
	it("replays the latest v4 locator patch without requiring a trailing newline", () => {
		const bytes = encode(
			[
				header(),
				{ type: "message", role: "assistant", content: "unrelated" },
				{ type: "header_patch", patch: { title: "retained title" } },
				{ type: "header_patch", patch: { taskArtifactOwner: updated, cwd: "/workspace", starred: true } },
			],
			false,
		);
		expect(taskArtifactOwnerLocatorFromTranscriptBytes(bytes, sessionId)).toEqual(updated);
	});

	it("introduces a locator through a valid v4 patch and leaves v3 replay unchanged", () => {
		const patch = { type: "header_patch", patch: { taskArtifactOwner: updated, titleSource: "auto" } };
		expect(
			taskArtifactOwnerLocatorFromTranscriptBytes(
				encode([{ type: "session", version: 4, id: sessionId }, patch]),
				sessionId,
			),
		).toEqual(updated);
		expect(taskArtifactOwnerLocatorFromTranscriptBytes(encode([header(3), patch]), sessionId)).toEqual(initial);
	});

	it("rejects malformed later owner patches rather than falling back to the header locator", () => {
		for (const patch of [
			{ type: "header_patch", patch: { taskArtifactOwner: updated }, unexpected: true },
			{ type: "header_patch", patch: { taskArtifactOwner: updated, unexpected: true } },
			{ type: "header_patch", patch: { taskArtifactOwner: updated, titleSource: "manual" } },
			{ type: "header_patch", patch: { taskArtifactOwner: updated, starred: "yes" } },
			{ type: "header_patch", patch: { taskArtifactOwner: { ...updated, directoryIno: "056" } } },
			{ type: "header_patch", patch: { taskArtifactOwner: null } },
		]) {
			expect(() => taskArtifactOwnerLocatorFromTranscriptBytes(encode([header(), patch]), sessionId)).toThrow(
				"task_artifact_owner_patch_invalid",
			);
		}
	});

	it("refuses truncated and invalid UTF-8 owner patch records", () => {
		const prefix = encode([header()]);
		const truncated = Buffer.concat([prefix, Buffer.from('{"type":"header_patch","patch":{"taskArtifactOwner":')]);
		expect(() => taskArtifactOwnerLocatorFromTranscriptBytes(truncated, sessionId)).toThrow(
			"task_artifact_owner_patch_invalid",
		);
		const invalidUtf8 = Buffer.concat([
			prefix,
			Buffer.from('{"type":"header_patch","patch":{"taskArtifactOwner":"'),
			Buffer.from([0xff]),
			Buffer.from('"}}\n'),
		]);
		expect(() => taskArtifactOwnerLocatorFromTranscriptBytes(invalidUtf8, sessionId)).toThrow(
			"task_artifact_owner_patch_invalid",
		);
	});

	it("rejects a different logical session and an invalid initial locator", () => {
		expect(() => taskArtifactOwnerLocatorFromTranscriptBytes(encode([header()]), "another-session")).toThrow(
			"task_artifact_owner_transcript_header_invalid",
		);
		expect(() =>
			taskArtifactOwnerLocatorFromTranscriptBytes(
				encode([{ ...header(), taskArtifactOwner: { ...initial, ownerId: "bad" } }]),
				sessionId,
			),
		).toThrow("task_artifact_owner_locator_invalid");
	});
});
