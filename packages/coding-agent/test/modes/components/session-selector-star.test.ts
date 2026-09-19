import { beforeAll, describe, expect, it, vi } from "bun:test";
import { SessionSelectorComponent } from "../../../src/modes/components/session-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { SessionInfo } from "../../../src/session/session-manager";

beforeAll(() => initTheme());

function session(id: string, starred = false): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title: id,
		starred,
		created: new Date(),
		modified: new Date(),
		messageCount: 1,
		size: 0,
		firstMessage: id,
		allMessagesText: id,
	};
}

function picker(sessions: SessionInfo[], save: (session: SessionInfo, starred: boolean) => Promise<void>) {
	const selected = vi.fn();
	const cancelled = vi.fn();
	const deleted = vi.fn(async () => true);
	const component = new SessionSelectorComponent(
		sessions,
		selected,
		cancelled,
		() => {},
		deleted,
		undefined,
		undefined,
		save,
	);
	const render = () => Bun.stripANSI(component.render(100).join("\n"));
	return { component, selected, cancelled, deleted, render };
}

const toggle = "\x13";
const down = "\x1b[B";

describe("session picker star shortcut", () => {
	it("restores original recency order after unstarring an initially pinned row", async () => {
		const { component, render, selected } = picker([session("recent"), session("older", true)], async () => {});
		component.handleInput(toggle);
		await Bun.sleep(0);
		expect(render().indexOf("recent")).toBeLessThan(render().indexOf("older"));
		component.handleInput("\n");
		expect(selected).toHaveBeenCalledWith("/tmp/older.jsonl");
	});

	it("persists star/unstar, reorders the list, and keeps the same session selected", async () => {
		const save = vi.fn(async () => {});
		const { component, render, selected } = picker([session("one"), session("two")], save);
		expect(render()).toContain("Ctrl+S to star/unstar");
		component.handleInput(down);
		component.handleInput(toggle);
		await Bun.sleep(0);
		expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ id: "two" }), true);
		expect(render()).toContain("★ two");
		expect(render().indexOf("★ two")).toBeLessThan(render().indexOf("one"));
		component.handleInput(toggle);
		await Bun.sleep(0);
		expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ id: "two" }), false);
		expect(render()).not.toContain("★ two");
		component.handleInput("\n");
		expect(selected).toHaveBeenCalledWith("/tmp/two.jsonl");
	});

	it("keeps search text, including plain s, and toggles only the filtered selection", async () => {
		const save = vi.fn(async () => {});
		const { component, render, selected } = picker([session("alpha"), session("special")], save);
		component.handleInput("s");
		expect(save).not.toHaveBeenCalled();
		component.handleInput("pec");
		component.handleInput(toggle);
		await Bun.sleep(0);
		expect(save).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "special" }), true);
		expect(render()).not.toContain("alpha");
		component.handleInput("\n");
		expect(selected).toHaveBeenCalledWith("/tmp/special.jsonl");
	});

	it("ignores toggles with no matching sessions", () => {
		const save = vi.fn(async () => {});
		const { component, render } = picker([session("one")], save);
		component.handleInput("zzz");
		component.handleInput(toggle);
		expect(render()).toContain("No sessions");
		expect(save).not.toHaveBeenCalled();
		picker([], save).component.handleInput(toggle);
		expect(save).not.toHaveBeenCalled();
	});

	it("freezes competing actions until persistence finishes without optimistic state changes", async () => {
		const pending = Promise.withResolvers<void>();
		const save = vi.fn(() => pending.promise);
		const { component, selected, deleted, render } = picker([session("one"), session("two")], save);
		component.handleInput(toggle);
		component.handleInput(toggle);
		component.handleInput(down);
		component.handleInput("\n");
		component.handleInput("\x1b[3~");
		component.handleInput("x");
		expect(save).toHaveBeenCalledTimes(1);
		expect(selected).not.toHaveBeenCalled();
		expect(deleted).not.toHaveBeenCalled();
		expect(render()).not.toContain("★ one");
		pending.resolve();
		await Bun.sleep(0);
		expect(render()).toContain("★ one");
		component.handleInput("\n");
		expect(selected).toHaveBeenCalledWith("/tmp/one.jsonl");
	});

	it("leaves the persisted UI state unchanged after failure and permits retry", async () => {
		const save = vi.fn(async () => {}).mockRejectedValueOnce(new Error("permission denied"));
		const { component, render } = picker([session("one")], save);
		component.handleInput(toggle);
		await Bun.sleep(0);
		expect(render()).toContain("Error: permission denied");
		expect(render()).not.toContain("★ one");
		component.handleInput(toggle);
		await Bun.sleep(0);
		expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ id: "one" }), true);
		expect(render()).toContain("★ one");
		expect(render()).not.toContain("permission denied");
	});

	it("allows cancellation while saving and ignores completion after the picker closes", async () => {
		const pending = Promise.withResolvers<void>();
		const { component, cancelled, selected, render } = picker([session("one")], () => pending.promise);
		component.handleInput(toggle);
		component.handleInput("\x1b");
		expect(cancelled).toHaveBeenCalledTimes(1);
		pending.resolve();
		await Bun.sleep(0);
		component.handleInput("\n");
		expect(selected).not.toHaveBeenCalled();
		expect(render()).not.toContain("★ one");
	});

	it("does not toggle while a delete confirmation is open", async () => {
		const save = vi.fn(async () => {});
		const { component, deleted } = picker([session("one")], save);
		component.handleInput("\x1b[3~");
		component.handleInput(toggle);
		expect(save).not.toHaveBeenCalled();
		component.handleInput("\x1b");
		component.handleInput(toggle);
		await Bun.sleep(0);
		expect(save).toHaveBeenCalledTimes(1);
		expect(deleted).not.toHaveBeenCalled();
	});
});
