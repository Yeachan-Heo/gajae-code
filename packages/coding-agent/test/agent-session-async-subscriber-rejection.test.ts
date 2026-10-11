import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { logger, TempDir } from "@gajae-code/utils";
import { ManagedAppendIdentityMismatchError } from "../src/session/internal/managed-session-storage";

describe("AgentSession async subscriber rejection", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};

	beforeEach(async () => {
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
		tempDir = TempDir.createSync("@pi-async-subscriber-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
	});

	afterEach(async () => {
		process.off("unhandledRejection", onUnhandled);
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("contains an async subscriber rejection instead of leaking an unhandled rejection", async () => {
		// Given: interactive mode subscribes with an async listener (event-controller
		// `subscribeToAgent`) whose handlers can persist, e.g. plan approval calling
		// `session.prompt()`. After another process resumes the same session the
		// managed append fence rejects that write.
		const subscriberWarning = vi.spyOn(logger, "warn");
		session.subscribe(async (_event: AgentSessionEvent) => {
			await Promise.resolve();
			throw new ManagedAppendIdentityMismatchError("session.jsonl");
		});
		const delivered: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") delivered.push(event.message);
		});

		// When
		session.emitNotice("info", "first");
		session.emitNotice("info", "second");
		await Bun.sleep(20);

		// Then: the rejection is logged like a synchronous throw, later events still reach
		// other subscribers, and nothing escapes to the process-level handler.
		expect(unhandled).toEqual([]);
		expect(delivered).toEqual(["first", "second"]);
		expect(subscriberWarning).toHaveBeenCalledWith("Agent session event subscriber failed", {
			event: "notice",
			error: expect.stringContaining("managed_append_identity_mismatch"),
		});
	});
});
