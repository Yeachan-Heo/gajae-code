import { expect, test } from "bun:test";
import { safeDiscoveryDiagnostic } from "../src/config/model-discovery-manager";
import {
	EventController,
	formatModelFallbackStatus,
	safeFallbackModelSelector,
} from "../src/modes/controllers/event-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import {
	type AgentSessionEvent,
	sanitizeModelFallbackReason,
	sanitizeModelFallbackSelector,
} from "../src/session/agent-session";

test("fallback status keeps canonical selectors and rejects secret/path-shaped values", () => {
	expect(safeFallbackModelSelector("anthropic/claude-sonnet\u001b[31m")).toBe("anthropic/claude-sonnet");
	expect(safeFallbackModelSelector("openai/gpt-5?api_key=SECRET")).toBe("unknown");
	expect(safeFallbackModelSelector("openai/../secret")).toBe("unknown");
	expect(formatModelFallbackStatus({ from: "anthropic/claude-sonnet", to: "openai/gpt-5" })).toBe(
		"Fallback model: anthropic/claude-sonnet → openai/gpt-5",
	);
});

test("producer sanitizes fallback selectors and diagnostic reasons before transport", () => {
	expect(sanitizeModelFallbackSelector("openai/gpt-5?api_key=SECRET")).toBe("<redacted-model>");
	expect(sanitizeModelFallbackSelector("openai/gpt-5\u001b[31m")).toBe("<redacted-model>");
	expect(sanitizeModelFallbackSelector("openai/gpt-5:high")).toBe("openai/gpt-5:high");
	expect(sanitizeModelFallbackReason("rate_limit: https://provider.invalid?token=SECRET")).toBe("unknown");
	expect(sanitizeModelFallbackReason("rate_limit")).toBe("rate_limit");
});

test("discovery diagnostics reduce hostile endpoint errors to stable safe categories", () => {
	const diagnostic = safeDiscoveryDiagnostic(
		new Error("HTTP 401 from https://provider.invalid/v1/models?api_key=SECRET at /Users/private/config"),
	);
	expect(diagnostic).toBe("HTTP 401");
	expect(diagnostic).not.toContain("provider.invalid");
	expect(diagnostic).not.toContain("SECRET");
});

test("EventController renders one bounded fallback status and invalidates current model truth", async () => {
	const statuses: string[] = [];
	const showStatus = (message: string): void => {
		statuses.push(message);
	};
	let invalidations = 0;
	let renders = 0;
	const ctx = {
		isInitialized: true,
		isStopped: () => false,
		showStatus,
		statusLine: {
			invalidate: () => {
				invalidations++;
			},
		},
		updateEditorTopBorder: () => {},
		ui: {
			requestRender: () => {
				renders++;
			},
		},
	} as unknown as InteractiveModeContext;
	const controller = new EventController(ctx);
	const event: Extract<AgentSessionEvent, { type: "model_fallback_switched" }> = {
		type: "model_fallback_switched",
		eventId: "fallback-safe-1",
		from: "anthropic/claude-sonnet?token=SECRET",
		to: "openai/gpt-5",
		reason: "rate_limit: secret details omitted",
		role: "default",
		scope: "session",
		activeIndex: 1,
		chainLength: 2,
		attemptsUsed: 1,
	};

	await controller.handleEvent(event);

	expect(statuses).toEqual(["Fallback model: unknown → openai/gpt-5"]);
	expect(statuses.join(" ")).not.toContain("SECRET");
	expect(statuses.join(" ")).not.toContain("rate_limit");
	expect(invalidations).toBeGreaterThanOrEqual(2);
	expect(renders).toBe(1);
});
