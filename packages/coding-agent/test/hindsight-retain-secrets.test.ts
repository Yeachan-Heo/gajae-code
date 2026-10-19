import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { HindsightApi } from "@gajae-code/coding-agent/hindsight/client";
import type { HindsightConfig } from "@gajae-code/coding-agent/hindsight/config";
import { HindsightSessionState } from "@gajae-code/coding-agent/hindsight/state";
import { HindsightRetainTool } from "@gajae-code/coding-agent/tools/hindsight-retain";
import type { ToolSession } from "@gajae-code/coding-agent/tools/index";

const GITHUB = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
const AWS = "AKIA1234567890ABCDEF";

function makeConfig(): HindsightConfig {
	return {
		hindsightApiUrl: "http://localhost:8888",
		hindsightApiToken: null,
		bankId: null,
		bankIdPrefix: "",
		scoping: "global",
		bankMission: "",
		retainMission: null,
		autoRecall: true,
		autoRetain: true,
		retainMode: "full-session",
		retainEveryNTurns: 3,
		retainOverlapTurns: 2,
		retainContext: "gjc",
		recallBudget: "mid",
		recallMaxTokens: 1024,
		recallTypes: ["world", "experience"],
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		recallPromptPreamble: "preamble",
		debug: false,
		mentalModelsEnabled: false,
		mentalModelAutoSeed: false,
		mentalModelRefreshIntervalMs: 5 * 60 * 1000,
		mentalModelMaxRenderChars: 16_000,
	};
}

function makeState(client: HindsightApi): HindsightSessionState {
	let state: HindsightSessionState;
	state = new HindsightSessionState({
		sessionId: "retain-secrets",
		client,
		bankId: "test-bank",
		config: makeConfig(),
		session: {
			sessionId: "retain-secrets",
			sessionManager: { getEntries: () => [] },
			emitNotice: () => {},
			getHindsightSessionState: () => state,
		} as never,
		missionsSet: new Set(),
		lastRetainedTurn: 0,
		hasRecalledForFirstTurn: false,
	});
	return state;
}

function makeSession(state: HindsightSessionState): ToolSession {
	const settings = Settings.isolated({ "memory.backend": "hindsight" });
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => "retain-secrets",
		getSessionSpawns: () => null,
		getHindsightSessionState: () => state,
	} as unknown as ToolSession;
}

describe("hindsight retain secret scrub", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("still allows an ordinary transcript", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const state = makeState(client);
		const prose = "the password field stayed empty after the deploy finished";
		const retained = await state.retainSession([{ role: "user", content: prose }]);
		expect(retained).toBe(true);
		const transcript = String(retain.mock.calls[0]?.[1]);
		expect(transcript).toContain(prose);
		expect(transcript).toContain("[role: user]");
	});

	it("redacts a secret in a retained transcript", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const state = makeState(client);
		const retained = await state.retainSession([
			{ role: "user", content: `the deploy step used ${GITHUB} for auth` },
		]);
		expect(retained).toBe(true);
		const transcript = String(retain.mock.calls[0]?.[1]);
		expect(transcript).not.toContain(GITHUB);
		expect(transcript).toContain("[REDACTED]");
		expect(transcript).toContain("the deploy step used");
	});

	it("still allows an ordinary queued memory", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retainBatch = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		const state = makeState(client);
		const tool = HindsightRetainTool.createIf(makeSession(state))!;
		await tool.execute("call-plain", {
			items: [{ content: "fact one", context: "user override" }],
		});
		await state.flushRetainQueue();
		expect(retainBatch.mock.calls[0]?.[1]).toEqual([
			expect.objectContaining({ content: "fact one", context: "user override" }),
		]);
	});

	it("redacts a secret in a queued retain item", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retainBatch = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		const state = makeState(client);
		const tool = HindsightRetainTool.createIf(makeSession(state))!;
		await tool.execute("call-secret", {
			items: [{ content: `note ${GITHUB} end`, context: `label ${AWS} end` }],
		});
		await state.flushRetainQueue();
		const item = retainBatch.mock.calls[0]?.[1]?.[0] as { content: string; context: string };
		expect(item.content).not.toContain(GITHUB);
		expect(item.context).not.toContain(AWS);
		expect(item.content).toContain("note");
		expect(item.context).toContain("label");
	});
});
