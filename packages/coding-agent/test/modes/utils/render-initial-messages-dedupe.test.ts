/**
 * Regression test: renderInitialMessages must not call buildSessionContext when
 * a prebuilt context is supplied (e.g. from navigateTree's return value).
 *
 * Before the fix, renderInitialMessages always called sessionManager.buildSessionContext(),
 * duplicating the O(N) walk already done inside navigateTree.  After the fix,
 * renderInitialMessages accepts an optional prebuiltContext and skips the walk when provided.
 *
 * What these tests cover:
 *   - UiHelpers.renderInitialMessages skip/use of buildSessionContext (isolated unit tests).
 *   - End-to-end callcount using a real in-memory SessionManager: one build call total when
 *     the context is passed through, confirming the handoff contract works at runtime.
 *
 * What is NOT covered here (requires full AgentSession wiring):
 *   - That AgentSession.navigateTree actually sets result.sessionContext — enforced by
 *     the TypeScript return type and the agent-session unit tests.
 */

import { beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@gajae-code/coding-agent/session/session-manager";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

beforeAll(() => {
	initTheme();
});

/** Minimal empty SessionContext (what navigateTree returns when leafId is null). */
function makeEmptyContext(): SessionContext {
	return {
		messages: [],
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		configuredModelChains: {},
		injectedTtsrRules: [],
		selectedMCPToolNames: [],
		hasPersistedMCPToolSelection: false,
		mode: "none",
	};
}

/** Build a minimal InteractiveModeContext mock, returning spies for assertions. */
function makeCtx(sessionManager?: Pick<SessionManager, "buildSessionContext" | "getEntries" | "getCwd">): {
	ctx: InteractiveModeContext;
	buildSessionContextSpy: Mock<() => SessionContext>;
	renderSessionContextSpy: Mock<(...args: unknown[]) => void>;
} {
	const buildSessionContextSpy = vi.fn(() => makeEmptyContext());
	const renderSessionContextSpy = vi.fn();

	const sm = sessionManager ?? {
		buildSessionContext: buildSessionContextSpy,
		getEntries: vi.fn(() => []),
		getCwd: vi.fn(() => "/tmp"),
	};

	const ctx = {
		chatContainer: { clear: vi.fn(), addChild: vi.fn() },
		pendingMessagesContainer: { clear: vi.fn() },
		pendingBashComponents: [],
		pendingPythonComponents: [],
		sessionManager: sm,
		renderSessionContext: renderSessionContextSpy,
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;

	return { ctx, buildSessionContextSpy, renderSessionContextSpy };
}

// ─── Part 1: Isolated renderInitialMessages behaviour ─────────────────────────

describe("UiHelpers.renderInitialMessages — isolated", () => {
	it("calls sessionManager.buildSessionContext when no prebuilt context is given", () => {
		const { ctx, buildSessionContextSpy } = makeCtx();
		new UiHelpers(ctx).renderInitialMessages();
		expect(buildSessionContextSpy).toHaveBeenCalledTimes(1);
	});

	it("does NOT call sessionManager.buildSessionContext when a prebuilt context is provided", () => {
		const { ctx, buildSessionContextSpy } = makeCtx();
		new UiHelpers(ctx).renderInitialMessages(makeEmptyContext());
		expect(buildSessionContextSpy).toHaveBeenCalledTimes(0);
	});

	it("passes the prebuilt context directly to renderSessionContext", () => {
		const { ctx, renderSessionContextSpy } = makeCtx();
		const prebuilt = makeEmptyContext();
		new UiHelpers(ctx).renderInitialMessages(prebuilt);
		expect(renderSessionContextSpy).toHaveBeenCalledWith(prebuilt, {
			updateFooter: true,
			populateHistory: true,
		});
	});

	it("uses the fallback context from sessionManager when no prebuilt is provided", () => {
		const fallback = makeEmptyContext();
		const { ctx, renderSessionContextSpy } = makeCtx();
		(ctx.sessionManager.buildSessionContext as Mock<() => SessionContext>).mockReturnValue(fallback);
		new UiHelpers(ctx).renderInitialMessages();
		expect(renderSessionContextSpy).toHaveBeenCalledWith(fallback, {
			updateFooter: true,
			populateHistory: true,
		});
	});
});

// ─── Part 2: End-to-end callcount with a real SessionManager ─────────────────
//
// Simulates the selector-controller handoff: buildSessionContext is called once
// (representing navigateTree's internal call), and the result is passed directly
// to renderInitialMessages — which must NOT call it a second time.

describe("renderInitialMessages callcount with real SessionManager", () => {
	it("total buildSessionContext calls == 1 when context is threaded from navigate to render", async () => {
		const sm = SessionManager.inMemory("/tmp/test");
		// Append a user message with the required timestamp field.
		sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		const spy = vi.spyOn(sm, "buildSessionContext");

		// Step 1: one call — represents navigateTree's internal rawContext build.
		const context = sm.buildSessionContext();
		expect(spy).toHaveBeenCalledTimes(1);

		// Step 2: renderInitialMessages with the prebuilt context must NOT call it again.
		const { ctx } = makeCtx(sm as unknown as Parameters<typeof makeCtx>[0]);
		new UiHelpers(ctx).renderInitialMessages(context);

		expect(spy).toHaveBeenCalledTimes(1); // still exactly 1 — second walk eliminated
	});
});
