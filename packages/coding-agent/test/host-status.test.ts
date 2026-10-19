import { afterEach, describe, expect, it, vi } from "bun:test";
import { emitHostStatus } from "@gajae-code/coding-agent/modes/utils/host-status";

function withTeraxHost<T>(run: () => T): T {
	const previous = process.env.TERAX_TERMINAL;
	process.env.TERAX_TERMINAL = "1";
	try {
		return run();
	} finally {
		if (previous === undefined) {
			delete process.env.TERAX_TERMINAL;
		} else {
			process.env.TERAX_TERMINAL = previous;
		}
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("host status markers", () => {
	it("writes the agent-attributed OSC 777 marker for each event", () => {
		const output = { write: vi.fn(() => true) };

		withTeraxHost(() => {
			emitHostStatus("working", output);
			emitHostStatus("attention", output);
			emitHostStatus("finished", output);
		});

		expect(output.write).toHaveBeenNthCalledWith(1, "\x1b]777;notify;Terax;gjc;working\x07");
		expect(output.write).toHaveBeenNthCalledWith(2, "\x1b]777;notify;Terax;gjc;attention\x07");
		expect(output.write).toHaveBeenNthCalledWith(3, "\x1b]777;notify;Terax;gjc;finished\x07");
	});

	it("stays silent in a terminal that is not Terax", () => {
		const previous = process.env.TERAX_TERMINAL;
		delete process.env.TERAX_TERMINAL;
		const output = { write: vi.fn(() => true) };

		try {
			emitHostStatus("finished", output);
		} finally {
			if (previous !== undefined) process.env.TERAX_TERMINAL = previous;
		}

		// OSC 777 `notify;` is the rxvt extension: terminals that implement it
		// show a desktop notification instead of discarding the sequence.
		expect(output.write).not.toHaveBeenCalled();
	});

	it("stays silent when the Terax marker is empty", () => {
		const previous = process.env.TERAX_TERMINAL;
		process.env.TERAX_TERMINAL = "";
		const output = { write: vi.fn(() => true) };

		try {
			emitHostStatus("working", output);
		} finally {
			if (previous === undefined) {
				delete process.env.TERAX_TERMINAL;
			} else {
				process.env.TERAX_TERMINAL = previous;
			}
		}

		expect(output.write).not.toHaveBeenCalled();
	});

	it("emits a self-terminating OSC that carries no cursor movement", () => {
		const output = { write: vi.fn((_value: string) => true) };

		withTeraxHost(() => emitHostStatus("working", output));

		const written = output.write.mock.calls[0][0] as string;
		expect(written.startsWith("\x1b]")).toBe(true);
		expect(written.endsWith("\x07")).toBe(true);
		// A terminal that does not know the sequence discards it; nothing here
		// may render or move the cursor if it does not.
		expect(written.slice(2, -1)).toMatch(/^[\x20-\x7e]*$/);
	});

	it("swallows write failures so a broken stdout can't abort a turn", () => {
		const output = {
			write: vi.fn(() => {
				throw new Error("EPIPE");
			}),
		};

		expect(() => withTeraxHost(() => emitHostStatus("finished", output))).not.toThrow();
		expect(output.write).toHaveBeenCalledTimes(1);
	});
});
