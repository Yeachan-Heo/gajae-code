import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

async function records(file: string) {
	return (await Bun.file(file).text())
		.trim()
		.split("\n")
		.map(
			line =>
				JSON.parse(line) as {
					type: string;
					id?: string;
					parentId?: string;
					model?: string;
					role?: string;
					thinkingLevel?: string;
				},
		);
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("shared temporary model control", () => {
	for (const emitThinking of [false, true]) {
		it(`bootstraps pending history with ${emitThinking ? "two linked records" : "one temporary model record"}`, async () => {
			const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-temporary-bootstrap-"));
			roots.push(root);
			const cwd = path.join(root, "workspace");
			const agentDir = path.join(root, "agent");
			await fs.mkdir(cwd, { recursive: true });
			await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
			const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
			managers.push(manager);
			const pending = manager.appendMessage(user("original pending history"));
			const outcome = await manager.appendTemporaryModelChangeSharingSession(
				"anthropic/temporary",
				emitThinking ? { level: ThinkingLevel.High } : undefined,
				() => true,
			);
			expect(outcome.kind).toBe("committed");
			if (outcome.kind !== "committed") throw new Error(`Bootstrap: ${outcome.kind}`);
			expect(outcome.ids).toHaveLength(emitThinking ? 2 : 1);
			const file = manager.getSessionFile()!;
			const entries = await records(file);
			expect(entries[1]).toMatchObject({ type: "message", id: pending });
			expect(entries[2]).toMatchObject({
				type: "model_change",
				id: outcome.ids[0],
				parentId: pending,
				role: "temporary",
			});
			if (emitThinking)
				expect(entries[3]).toMatchObject({
					type: "thinking_level_change",
					id: outcome.ids[1],
					parentId: outcome.ids[0],
				});
			expect(manager.getLeafId()).toBe(outcome.ids[emitThinking ? 1 : 0]!);
			const later = await manager.appendMessageSharingSession(user("after bootstrap"));
			expect(later.kind).toBe("committed");
		});
	}
});
