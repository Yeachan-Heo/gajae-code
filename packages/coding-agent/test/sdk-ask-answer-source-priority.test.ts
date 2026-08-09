import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAskAnswerSource, registerAskAnswerSource } from "@gajae-code/coding-agent/tools/ask-answer-registry";

describe("ask answer source priority", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("selects the protocol source when it registers after an interactive source", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ask-source-priority-"));
		tempDirs.push(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated(),
			hasUI: true,
		});

		try {
			const interactive = { awaitAnswer: async () => undefined };
			const protocol = { awaitAnswer: async () => undefined };
			registerAskAnswerSource(session.sessionId, interactive, "interactive");
			registerAskAnswerSource(session.sessionId, protocol, "protocol");

			expect(getAskAnswerSource(session.sessionId)).toBe(protocol);
		} finally {
			await session.dispose?.();
		}
	});

	it("selects the protocol source when an interactive source registers later", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ask-source-priority-"));
		tempDirs.push(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated(),
			hasUI: true,
		});

		try {
			const protocol = { awaitAnswer: async () => undefined };
			const interactive = { awaitAnswer: async () => undefined };
			registerAskAnswerSource(session.sessionId, protocol, "protocol");
			registerAskAnswerSource(session.sessionId, interactive, "interactive");

			expect(getAskAnswerSource(session.sessionId)).toBe(protocol);
		} finally {
			await session.dispose?.();
		}
	});

	it("falls back to the interactive source after disposing the protocol source", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ask-source-priority-"));
		tempDirs.push(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated(),
			hasUI: true,
		});

		try {
			const protocol = { awaitAnswer: async () => undefined };
			const interactive = { awaitAnswer: async () => undefined };
			const disposeProtocol = registerAskAnswerSource(session.sessionId, protocol, "protocol");
			registerAskAnswerSource(session.sessionId, interactive, "interactive");
			disposeProtocol();

			expect(getAskAnswerSource(session.sessionId)).toBe(interactive);
		} finally {
			await session.dispose?.();
		}
	});

	it("keeps a protocol source ahead of a legacy two-argument interactive registration", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ask-source-priority-"));
		tempDirs.push(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated(),
			hasUI: true,
		});

		try {
			const protocol = { awaitAnswer: async () => undefined };
			const legacyInteractive = { awaitAnswer: async () => undefined };
			const disposeProtocol = registerAskAnswerSource(session.sessionId, protocol, "protocol");
			const disposeLegacyInteractive = registerAskAnswerSource(session.sessionId, legacyInteractive);

			expect(getAskAnswerSource(session.sessionId)).toBe(protocol);
			disposeProtocol();
			expect(getAskAnswerSource(session.sessionId)).toBe(legacyInteractive);
			disposeLegacyInteractive();
		} finally {
			await session.dispose?.();
		}
	});

	it("selects the most recently registered protocol source", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ask-source-priority-"));
		tempDirs.push(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated(),
			hasUI: true,
		});

		try {
			const firstProtocol = { awaitAnswer: async () => undefined };
			const secondProtocol = { awaitAnswer: async () => undefined };
			registerAskAnswerSource(session.sessionId, firstProtocol, "protocol");
			registerAskAnswerSource(session.sessionId, secondProtocol, "protocol");

			expect(getAskAnswerSource(session.sessionId)).toBe(secondProtocol);
		} finally {
			await session.dispose?.();
		}
	});

	it("returns undefined when no source is registered", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ask-source-priority-"));
		tempDirs.push(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated(),
			hasUI: true,
		});

		try {
			expect(getAskAnswerSource(session.sessionId)).toBeUndefined();
		} finally {
			await session.dispose?.();
		}
	});
});
