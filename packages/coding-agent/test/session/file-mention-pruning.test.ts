import { describe, expect, test } from "bun:test";
import { pruneStaleFileMentions } from "@gajae-code/coding-agent/session/file-mention-pruning";
import type { SessionEntry } from "@gajae-code/coding-agent/session/session-manager";

const resolveAbs = (p: string) => (p.startsWith("/") ? p : `/cwd/${p}`);

function mention(id: string, files: Array<{ path: string; content: string; pruned?: boolean }>): SessionEntry {
	return {
		type: "message",
		id,
		message: { role: "fileMention", files, timestamp: 0 },
	} as unknown as SessionEntry;
}

function readResult(id: string, resolvedPath: string): SessionEntry {
	return {
		type: "message",
		id,
		message: { role: "toolResult", toolName: "read", content: [], details: { resolvedPath } },
	} as unknown as SessionEntry;
}

function fileOf(entry: SessionEntry, index = 0) {
	const msg = (entry as unknown as { message: { files: Array<{ content: string; pruned?: boolean }> } }).message;
	return msg.files[index];
}

describe("pruneStaleFileMentions (Finding 5)", () => {
	test("supersession by a later mention prunes the older body to an explicit notice", () => {
		const entries = [
			mention("m0", [{ path: "a.txt", content: "BODY_A_OLD ".repeat(50) }]),
			mention("m1", [{ path: "a.txt", content: "BODY_A_NEW" }]),
		];

		const result = pruneStaleFileMentions(entries, resolveAbs);

		expect(result.changed).toHaveLength(1);
		expect(result.bytesSaved).toBeGreaterThan(0);
		// Older body replaced with an explicit notice (never deleted).
		expect(fileOf(entries[0]!)?.pruned).toBe(true);
		expect(fileOf(entries[0]!)?.content).toContain("pruned");
		expect(fileOf(entries[0]!)?.content).not.toContain("BODY_A_OLD");
		// Newest copy is preserved verbatim.
		expect(fileOf(entries[1]!)?.pruned).toBeUndefined();
		expect(fileOf(entries[1]!)?.content).toBe("BODY_A_NEW");
		// Entry count is unchanged — pruning never deletes entries.
		expect(entries).toHaveLength(2);
	});

	test("a later read of the same path prunes the earlier mention", () => {
		const entries = [mention("m0", [{ path: "b.txt", content: "BODY_B" }]), readResult("r0", "/cwd/b.txt")];

		const result = pruneStaleFileMentions(entries, resolveAbs);

		expect(result.changed).toHaveLength(1);
		expect(fileOf(entries[0]!)?.pruned).toBe(true);
		expect(fileOf(entries[0]!)?.content).toContain("pruned");
	});

	test("the newest mention and non-superseded paths are left intact", () => {
		const entries = [
			mention("m0", [{ path: "a.txt", content: "ONLY_A" }]),
			mention("m1", [{ path: "c.txt", content: "ONLY_C" }]),
		];

		const result = pruneStaleFileMentions(entries, resolveAbs);

		expect(result.changed).toHaveLength(0);
		expect(fileOf(entries[0]!)?.content).toBe("ONLY_A");
		expect(fileOf(entries[1]!)?.content).toBe("ONLY_C");
	});

	test("already-pruned entries are not re-processed", () => {
		const entries = [
			mention("m0", [{ path: "a.txt", content: "already", pruned: true }]),
			mention("m1", [{ path: "a.txt", content: "NEW" }]),
		];

		const result = pruneStaleFileMentions(entries, resolveAbs);

		expect(result.changed).toHaveLength(0);
		expect(fileOf(entries[0]!)?.content).toBe("already");
	});
});
