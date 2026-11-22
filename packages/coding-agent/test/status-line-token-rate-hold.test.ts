import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { initTheme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	mock.restore();
	resetSettingsForTest();
});

type TestMessage = Record<string, unknown>;

function assistant(timestamp: number, output: number, duration?: number, ttft?: number): TestMessage {
	return { role: "assistant", content: [], timestamp, duration, ttft, usage: { output } };
}

function makeSession(messages: TestMessage[]): AgentSession {
	return {
		messages,
		state: { messages, model: { id: "test-model", contextWindow: 100_000 } },
		model: { id: "test-model", contextWindow: 100_000 },
		systemPrompt: ["You are a test assistant."],
		agent: { state: { tools: [] } },
		skills: [],
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "token-rate-hold",
		},
		isStreaming: false,
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as AgentSession;
}

function makeComponent(session: AgentSession): StatusLineComponent {
	const component = new StatusLineComponent(session);
	component.updateSettings({
		preset: "custom",
		leftSegments: ["token_rate"],
		rightSegments: [],
		showSkillHud: false,
		showHookStatus: false,
		sessionAccent: false,
	});
	return component;
}

function renderText(component: StatusLineComponent): string {
	return Bun.stripANSI(component.render(120).join("\n"));
}

describe("status line token rate", () => {
	it("keeps showing the last measured rate while a new turn has no measurable rate yet", () => {
		const messages: TestMessage[] = [{ role: "user", content: "hi" }, assistant(1_000, 300, 3_000, 1_000)];
		const component = makeComponent(makeSession(messages));
		expect(renderText(component)).toContain("150.0/s");

		// New assistant turn whose output arrived in one burst right after the
		// first token: the post-ttft window is too short to measure.
		messages.push({ role: "user", content: "next" }, assistant(9_000, 20, 5_020, 5_000));
		component.invalidate();
		expect(renderText(component)).toContain("150.0/s");
	});

	it("hides the rate when the session has no assistant message", () => {
		const component = makeComponent(makeSession([{ role: "user", content: "hi" }]));
		expect(renderText(component)).not.toContain("/s");
	});
});
