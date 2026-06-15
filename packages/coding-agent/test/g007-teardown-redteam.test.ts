import { describe, expect, it } from "bun:test";
import { disposeCursorConversation } from "@gajae-code/ai/providers/cursor";
import { waitForProjectLoaded } from "@gajae-code/coding-agent/lsp/client";

type LspClient = Parameters<typeof waitForProjectLoaded>[0];

type TrackedSignal = {
	signal: AbortSignal;
	readonly added: number;
	readonly removed: number;
	readonly active: number;
	fire: () => void;
};

function trackedSignal(initiallyAborted = false): TrackedSignal {
	// Faithful to real AbortSignal { once: true } semantics: a once-listener is auto-removed when the
	// abort event fires. dev's shared untilAborted helper relies on this for its abort-path cleanup.
	const listeners = new Map<() => void, boolean>();
	const state = { aborted: initiallyAborted, added: 0, removed: 0 };
	const signal = {
		get aborted() {
			return state.aborted;
		},
		reason: undefined,
		onabort: null,
		throwIfAborted: () => {
			if (state.aborted) throw new DOMException("Aborted", "AbortError");
		},
		addEventListener: (type: string, callback: (() => void) | null, options?: { once?: boolean }) => {
			if (type !== "abort" || callback === null) return;
			state.added += 1;
			listeners.set(callback, options?.once === true);
		},
		removeEventListener: (type: string, callback: (() => void) | null) => {
			if (type !== "abort" || callback === null) return;
			if (listeners.delete(callback)) state.removed += 1;
		},
		dispatchEvent: () => true,
	} as AbortSignal;

	return {
		signal,
		get added() {
			return state.added;
		},
		get removed() {
			return state.removed;
		},
		get active() {
			return listeners.size;
		},
		fire: () => {
			state.aborted = true;
			for (const [listener, once] of [...listeners]) {
				if (once) {
					listeners.delete(listener);
					state.removed += 1;
				}
				listener();
			}
		},
	};
}

function lspClient(projectLoaded: Promise<void>): LspClient {
	return { projectLoaded } as LspClient;
}

describe("G007 teardown red-team: waitForProjectLoaded abort listener lifecycle (F17)", () => {
	it("removes the abort listener when projectLoaded resolves first", async () => {
		const tracker = trackedSignal();
		await waitForProjectLoaded(lspClient(Promise.resolve()), tracker.signal);
		expect(tracker.added).toBe(1);
		expect(tracker.removed).toBe(1);
		expect(tracker.active).toBe(0);
	});

	it("removes the abort listener and rejects when abort fires first", async () => {
		const tracker = trackedSignal();
		const pending = waitForProjectLoaded(lspClient(new Promise<void>(() => {})), tracker.signal);
		tracker.fire();
		// dev's shared untilAborted helper rejects with AbortError on abort; the F17 fix is that the
		// listener is still removed in its finally, so nothing accumulates on the prompt-scoped signal.
		await expect(pending).rejects.toThrow();
		expect(tracker.added).toBe(1);
		expect(tracker.removed).toBe(1);
		expect(tracker.active).toBe(0);
	});

	it("returns immediately for an already-aborted signal without adding a listener", async () => {
		const tracker = trackedSignal(true);
		await waitForProjectLoaded(lspClient(new Promise<void>(() => {})), tracker.signal);
		expect(tracker.added).toBe(0);
		expect(tracker.removed).toBe(0);
		expect(tracker.active).toBe(0);
	});

	it("resolves without listener churn when no signal is provided", async () => {
		await waitForProjectLoaded(lspClient(Promise.resolve()));
		expect(true).toBe(true);
	});

	it("does not accumulate listeners across repeated calls on the same signal", async () => {
		const tracker = trackedSignal();
		const callCount = 25;
		for (let index = 0; index < callCount; index += 1) {
			await waitForProjectLoaded(lspClient(Promise.resolve()), tracker.signal);
		}
		expect(tracker.added).toBe(callCount);
		expect(tracker.removed).toBe(callCount);
		expect(tracker.active).toBe(0);
	});

	it("removes the abort listener when projectLoaded rejects", async () => {
		const tracker = trackedSignal();
		const rejection = new Error("project load failed");
		try {
			await waitForProjectLoaded(lspClient(Promise.reject(rejection)), tracker.signal);
			expect.unreachable("projectLoaded rejection should propagate");
		} catch (error: unknown) {
			expect(error).toBe(rejection);
		}
		expect(tracker.added).toBe(1);
		expect(tracker.removed).toBe(1);
		expect(tracker.active).toBe(0);
	});
});

describe("G007 teardown red-team: Cursor conversation dispose hook (F15)", () => {
	it("is idempotent and no-throws for an unknown conversation id", () => {
		expect(() => disposeCursorConversation("g007-redteam-unknown-conversation")).not.toThrow();
		expect(() => disposeCursorConversation("g007-redteam-unknown-conversation")).not.toThrow();
	});
});
