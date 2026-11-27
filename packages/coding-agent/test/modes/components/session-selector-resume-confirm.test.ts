import { beforeAll, describe, expect, it, vi } from "bun:test";
import { HookSelectorComponent } from "../../../src/modes/components/hook-selector";
import { type SessionSelectionResult, SessionSelectorComponent } from "../../../src/modes/components/session-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { ResumeSessionIdentity } from "../../../src/sdk/session-readonly/storage";
import { SESSION_HANDOVER_BUSY_MESSAGE, type SessionHandoverOutcome } from "../../../src/session/session-handover";
import type { ResumeTailInspection, SessionInfo } from "../../../src/session/session-manager";
import { SessionHeldError } from "../../../src/session/session-ownership";

beforeAll(() => initTheme());

function session(id: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title: id,
		starred: false,
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

	it("marks and prioritizes starred sessions in the picker", () => {
		const starred = { ...session("important"), starred: true };
		const component = selector(async () => inspection("important", "terminal"), [], [session("ordinary"), starred]);
		const rendered = text(component);
		expect(rendered).toContain("★ important");
		expect(rendered.indexOf("★ important")).toBeLessThan(rendered.indexOf("ordinary"));
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

	it("marks held rows; choosing one warns, Cancel returns to the list and Fork settles a fork", async () => {
		const holder = { surface: "terminal" as const, pid: 4242 };
		const error = new SessionHeldError("01a21a7f-82ff-7332-bee3-31b605a15de0", holder);
		const results: SessionSelectionResult[] = [];
		const inspect = vi.fn(async () => inspection("one", "resumable"));
		const component = selector(inspect, results);
		component.setHeldSessions(new Map([["one", error]]), async () => ({ error }));
		const list = text(component);
		expect(list).toContain("one  • in terminal");
		expect(list).not.toContain("two  •");

		component.handleInput("\n");
		await Bun.sleep(0);
		const warning = text(component);
		expect(warning).toContain("This session is open in another process");
		expect(warning).toContain("Session 01a21a7f is open for writing in another terminal (pid 4242).");
		expect(warning).toContain("Fork into a new session");
		expect(warning).not.toContain("Resume this session?");
		component.handleInput("\x1b");
		expect(text(component)).not.toContain("This session is open in another process");
		expect(results).toEqual([]);

		component.handleInput("\n");
		await Bun.sleep(0);
		component.handleInput("\n");
		expect(results).toEqual([{ kind: "fork", path: "/tmp/one.jsonl", error }]);
		// The held session is never inspected for a resume: a fork opens idle.
		expect(inspect).not.toHaveBeenCalled();
		// Not a broker-launched holder: no Continue here.
		expect(warning).not.toContain("Continue here");
	});

	it("Continue here confirms before it hands over; a refusal warns again; the claim rides with the selection", async () => {
		const error = new SessionHeldError("01a21a7f-82ff-7332-bee3-31b605a15de0", { surface: "sdk-host", pid: 4242 });
		const results: SessionSelectionResult[] = [];
		const inspect = vi.fn(async () => inspection("one", "resumable"));
		const claim = {
			sessionId: "one",
			surface: "terminal",
			shared: false,
			released: false,
			release: vi.fn(),
		} as const;
		const closing = Promise.withResolvers<SessionHandoverOutcome>();
		const outcomes: Promise<SessionHandoverOutcome>[] = [
			Promise.resolve({ kind: "refused", message: SESSION_HANDOVER_BUSY_MESSAGE }),
			closing.promise,
		];
		const handOver = vi.fn(() => outcomes.shift()!);
		const component = selector(inspect, results);
		component.setHeldSessions(new Map([["one", error]]), async () => ({ error, handOver }));

		component.handleInput("\n");
		await Bun.sleep(0);
		expect(text(component)).toContain("Continue here");
		// Nothing is closed before the final yes: the read-only inspection and the confirmation first.
		component.handleInput("h");
		await Bun.sleep(0);
		expect(text(component)).toContain("Resume this session?");
		expect(handOver).not.toHaveBeenCalled();
		component.handleInput("y");
		await Bun.sleep(0);
		const refused = text(component);
		expect(refused).toContain("This session is open in another process");
		expect(refused).toContain(SESSION_HANDOVER_BUSY_MESSAGE);

		component.handleInput("h");
		await Bun.sleep(0);
		component.handleInput("y");
		await Bun.sleep(0);
		expect(handOver).toHaveBeenCalledTimes(2);
		// The handover cannot be interrupted: Escape and Ctrl+C while it runs settle nothing.
		expect(text(component)).toContain("Handing the session over");
		component.handleInput("\x1b");
		component.handleInput("\x03");
		expect(results).toEqual([]);
		closing.resolve({ kind: "closed", claim });
		await Bun.sleep(0);
		// The tail is read again under the claim before the selection settles.
		expect(inspect).toHaveBeenCalledTimes(3);
		expect(results).toEqual([
			expect.objectContaining({
				kind: "selected",
				path: "/tmp/one.jsonl",
				action: "continue-tail",
				admission: claim,
			}),
		]);
		expect(claim.release).not.toHaveBeenCalled();
	});

	it("observes async onSelect rejections without unhandled rejection (#3804)", async () => {
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			const selected = vi.fn(async () => {
				throw new Error("Managed session changed before migration authority was adopted.");
			});
			const component = new SessionSelectorComponent(
				[session("one")],
				selected,
				() => {},
				() => {},
				undefined,
			);
			component.handleInput("\n");
			await Bun.sleep(0);
			await new Promise<void>(resolve => setImmediate(resolve));

			expect(selected).toHaveBeenCalledWith("/tmp/one.jsonl");
			expect(text(component)).toContain("Error: Managed session changed before migration authority was adopted.");
			// Picker stays usable for another attempt (no auto-retry of the same candidate).
			expect(text(component)).toContain("one");
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});
});
