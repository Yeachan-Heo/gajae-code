import { beforeAll, describe, expect, it } from "bun:test";
import { QueuePaneComponent } from "@gajae-code/coding-agent/modes/components/queue-pane";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

describe("QueuePaneComponent", () => {
	it("lists steering and follow-up entries and forwards reorder/remove controls", () => {
		const deleted: string[] = [];
		const moved: Array<{ id: string; direction: string }> = [];
		const pane = new QueuePaneComponent(
			[
				{ id: "steer:1", text: "interrupt", mode: "steer", label: "Steer" },
				{ id: "followUp:2", text: "later", mode: "followUp", label: "Queued" },
			],
			{
				onDelete: entry => deleted.push(entry.id),
				onMove: (entry, _index, direction) => moved.push({ id: entry.id, direction }),
				onClose: () => {},
			},
		);

		expect(pane.render(80).join("\n")).toContain("Message queue");
		pane.handleInput("\x1b[1;5B");
		pane.handleInput("\x1b[3~");
		expect(moved).toEqual([{ id: "steer:1", direction: "down" }]);
		expect(deleted).toEqual(["steer:1"]);
	});
});
