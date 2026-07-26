import { describe, expect, it } from "bun:test";
import { Text } from "../src/components/text";
import { TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

describe("generation-scoped render commits", () => {
	it("resolves after the requested generation writes successfully", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.start();
		tui.addChild(new Text("resume-progress", 1, 0));

		const generation = tui.requestRenderWithGeneration(false, "test.resume-progress");
		expect(await tui.waitForRenderCommit(generation)).toBe(true);
		expect(terminal.getWriteLog().join(" ")).toContain("resume-progress");

		tui.stop();
	});

	it("fails open immediately after the renderer is stopped", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.start();
		tui.stop();

		const generation = tui.requestRenderWithGeneration(false, "test.stopped");
		expect(await tui.waitForRenderCommit(generation)).toBe(false);
	});
});
