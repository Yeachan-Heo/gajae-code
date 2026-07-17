import { beforeAll, describe, expect, it, vi } from "bun:test";
import { HookSelectorComponent } from "../../../src/modes/components/hook-selector";
import { type SessionSelectionResult, SessionSelectorComponent } from "../../../src/modes/components/session-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { ResumeSessionIdentity, ResumeTailInspection, SessionInfo } from "../../../src/session/session-manager";

beforeAll(() => initTheme());

function session(id: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title: id,
		created: new Date(),
		modified: new Date(),
		messageCount: 1,
		size: 0,
		firstMessage: id,
		allMessagesText: id,
	};
}

function identity(id: string): ResumeSessionIdentity {
	return {
		canonicalPath: `/tmp/${id}.jsonl`,
		sessionId: id,
		dev: 1n,
		ino: 1n,
		size: 0,
		mtimeMs: 0,
		mtimeNs: 0n,
		sha256: id,
	};
}

function inspection(id: string, kind: "resumable" | "terminal"): ResumeTailInspection {
	return { kind, identity: identity(id) };
}

function selector(
	inspect: (path: string) => Promise<ResumeTailInspection>,
	results: SessionSelectionResult[],
	sessions = [session("one"), session("two")],
): SessionSelectorComponent {
	return new SessionSelectorComponent(
		sessions,
		() => {},
		() => {},
		() => {},
		undefined,
		inspect,
		result => results.push(result),
	);
}

function text(component: SessionSelectorComponent): string {
	return Bun.stripANSI(component.render(100).join("\n"));
}

describe("SessionSelectorComponent resume consent", () => {
	it("maps y/Y/n/N only when HookSelector accelerators are configured", () => {
		const selected: string[] = [];
		const dialog = new HookSelectorComponent(
			"Question",
			["Yes", "No"],
			option => selected.push(option),
			() => {},
			{
				acceleratorMap: { y: "Yes", n: "No" },
			},
		);
		dialog.handleInput("y");
		dialog.handleInput("Y");
		dialog.handleInput("n");
		dialog.handleInput("N");
		expect(selected).toEqual(["Yes", "Yes", "No", "No"]);
	});

	it("keeps the legacy five-argument selector immediate and modal-free", () => {
		const selected = vi.fn();
		const component = new SessionSelectorComponent(
			[session("one")],
			selected,
			() => {},
			() => {},
			undefined,
		);
		component.handleInput("\n");
		expect(selected).toHaveBeenCalledWith("/tmp/one.jsonl");
		expect(text(component)).not.toContain("Resume this session?");
	});

	it("uses Enter for yes and Escape for cancellation", async () => {
		const results: SessionSelectionResult[] = [];
		const component = selector(async () => inspection("one", "resumable"), results);
		component.handleInput("\n");
		await Bun.sleep(0);
		component.handleInput("\n");
		expect(results).toEqual([
			{ kind: "selected", path: "/tmp/one.jsonl", identity: identity("one"), action: "continue-tail" },
		]);
		const cancelled: SessionSelectionResult[] = [];
		const escaped = selector(async () => inspection("one", "resumable"), cancelled);
		escaped.handleInput("\n");
		await Bun.sleep(0);
		escaped.handleInput("\x1b");
		expect(cancelled).toEqual([{ kind: "cancelled" }]);
	});

	it("shows at most one confirmation and never shows one for terminal sessions", async () => {
		const results: SessionSelectionResult[] = [];
		const component = selector(async () => inspection("one", "resumable"), results);
		component.handleInput("\n");
		component.handleInput("\n");
		await Bun.sleep(0);
		expect(text(component).match(/Resume this session\?/g)).toHaveLength(1);
		const terminal = selector(async () => inspection("one", "terminal"), results);
		terminal.handleInput("\n");
		await Bun.sleep(0);
		expect(text(terminal)).not.toContain("Resume this session?");
		expect(results.at(-1)).toEqual({
			kind: "selected",
			path: "/tmp/one.jsonl",
			identity: identity("one"),
			action: "open-idle",
		});
	});

	it("cancels checking, ignores stale inspections, and freezes list-changing input", async () => {
		const pending = Promise.withResolvers<ResumeTailInspection>();
		const calls = vi.fn((_path: string) => pending.promise);
		const results: SessionSelectionResult[] = [];
		const component = selector(calls, results);
		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[3~");
		component.handleInput("x");
		expect(calls).toHaveBeenCalledWith("/tmp/one.jsonl");
		component.handleInput("\x1b");
		pending.resolve(inspection("one", "resumable"));
		await Bun.sleep(0);
		expect(text(component)).not.toContain("Resume this session?");
		expect(results).toEqual([{ kind: "cancelled" }]);
	});

	it("recovers from inspection failures without settling", async () => {
		const results: SessionSelectionResult[] = [];
		const component = selector(async () => {
			throw new Error("unreadable");
		}, results);
		component.handleInput("\n");
		await Bun.sleep(0);
		expect(text(component)).toContain("Error: unreadable");
		expect(results).toEqual([]);
	});
});
