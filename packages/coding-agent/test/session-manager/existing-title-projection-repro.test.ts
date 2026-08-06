import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	loadEntriesFromFile,
	SessionManager,
} from "@gajae-code/coding-agent/session/session-manager";

describe("existing title picker projection reproduction", () => {
	let testDir: string | undefined;

	afterEach(() => {
		if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("surfaces a canonical title patch outside the bounded picker projection", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-existing-title-projection-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		const sessionId = "existing-title-projection-repro";
		const sessionFile = path.join(sessionDir, "repro.jsonl");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });

		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			timestamp: "2026-07-31T00:00:00.000Z",
			cwd,
		};
		const titlePatch = {
			type: "header_patch",
			patch: { title: "persisted-alias", titleSource: "user" },
		};
		const records = Array.from({ length: 32 }, (_, index) => ({
			type: "message",
			id: `completed-${index}`,
			parentId: index === 0 ? null : `completed-${index - 1}`,
			timestamp: `2026-07-31T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
			message: {
				role: "assistant",
				content: [{ type: "text", text: `synthetic ${index}: ${"x".repeat(500)}` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "synthetic-model",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: index + 1,
			},
		}));

		const prefixCount = 5;
		const lines = [header, ...records.slice(0, prefixCount), titlePatch, ...records.slice(prefixCount)].map(record =>
			JSON.stringify(record),
		);
		const trailingBytes = Buffer.byteLength(`${lines.slice(prefixCount + 2).join("\n")}\n`);
		expect(trailingBytes).toBeGreaterThan(16 * 1024);
		expect(Math.max(...lines.slice(1).map(line => Buffer.byteLength(line)))).toBeLessThan(1024);
		fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`);

		const entries = await loadEntriesFromFile(sessionFile);
		expect(entries[0]).toMatchObject({
			type: "session",
			id: sessionId,
			title: "persisted-alias",
			titleSource: "user",
		});

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		const candidate = candidates.find(item => item.id === sessionId);
		expect(candidate).toBeDefined();
		expect(candidate?.title).toBe("persisted-alias");
	});
});
