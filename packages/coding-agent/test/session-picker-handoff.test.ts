import { beforeAll, expect, test, vi } from "bun:test";
import { ProcessTerminal, TUI } from "@gajae-code/tui";
import { selectSession } from "../src/cli/session-picker";
import { SessionSelectorComponent } from "../src/modes/components/session-selector";
import { initTheme } from "../src/modes/theme/theme";
import { type ResumeSessionIdentity, type SessionInfo, SessionManager } from "../src/session/session-manager";

beforeAll(() => initTheme());

test.each(["cancel", "select"] as const)("picker %s settles once, after teardown on the next turn", async action => {
	const session: SessionInfo = {
		path: "/synthetic/picker.jsonl",
		id: "picker",
		starred: false,
		cwd: "/synthetic",
		title: "Picker handoff",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 2,
		size: 0,
		firstMessage: "Synthetic history",
		allMessagesText: "Synthetic history",
	};
	const identity: ResumeSessionIdentity = {
		canonicalPath: session.path,
		sessionId: session.id,
		dev: 1n,
		ino: 1n,
		size: 0,
		mtimeMs: 0,
		mtimeNs: 0n,
		sha256: "synthetic",
	};
	const started: TUI[] = [];
	const stopped: TUI[] = [];
	const start = vi.spyOn(TUI.prototype, "start").mockImplementation(function (this: TUI) {
		started.push(this);
	});
	const stop = vi.spyOn(TUI.prototype, "stop").mockImplementation(function (this: TUI) {
		stopped.push(this);
	});
	const inspect = vi
		.spyOn(SessionManager, "inspectSessionTailReadOnly")
		.mockResolvedValue({ kind: "terminal", identity });
	try {
		let resolved = false;
		const selection = selectSession([session]).then(result => {
			expect(stopped).toEqual([started[0]]);
			resolved = true;
			return result;
		});
		const selector = started[0]?.children.find(child => child instanceof SessionSelectorComponent);
		if (!(selector instanceof SessionSelectorComponent)) throw new Error("Picker did not start");
		if (action === "select") {
			selector.handleInput("\r");
			await Promise.resolve();
		}
		// Repeated exit callbacks exercise selectSession's own single-settle guard.
		selector.handleInput("\x03");
		selector.handleInput("\x03");
		await Promise.resolve();
		expect(stopped).toHaveLength(0);
		expect(resolved).toBe(false);
		expect(await selection).toEqual(
			action === "select"
				? { kind: "selected", path: session.path, identity, action: "open-idle" }
				: { kind: "cancelled" },
		);
		const next = new TUI(new ProcessTerminal());
		next.start();
		selector.handleInput("\x03");
		selector.handleInput("\x03");
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		expect(started).toHaveLength(2);
		expect(stopped).toEqual([started[0]]);
	} finally {
		inspect.mockRestore();
		stop.mockRestore();
		start.mockRestore();
	}
});
