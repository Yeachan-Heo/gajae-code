import { describe, expect, it } from "bun:test";
import { resolveTerminalColumns, resolveTerminalRows } from "../src/terminal";

describe("terminal size resolution", () => {
	it("prefers the live TTY window size over stale stream defaults", () => {
		const stream = {
			columns: 80,
			rows: 24,
			getWindowSize: () => [180, 52],
		};

		expect(resolveTerminalColumns(stream, undefined)).toBe(180);
		expect(resolveTerminalRows(stream, undefined)).toBe(52);
	});

	it("falls back to stream and environment dimensions when live size is unavailable", () => {
		expect(resolveTerminalColumns({ columns: 132 }, "200")).toBe(132);
		expect(resolveTerminalRows({ rows: 40 }, "60")).toBe(40);
		expect(resolveTerminalColumns({}, "200")).toBe(200);
		expect(resolveTerminalRows({}, "60")).toBe(60);
		expect(resolveTerminalColumns({}, "")).toBe(80);
		expect(resolveTerminalRows({}, "")).toBe(24);
	});
});
