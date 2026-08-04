import { afterEach, describe, expect, it, vi } from "bun:test";
import { emitHostStatus } from "@gajae-code/coding-agent/modes/utils/host-status";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("host status markers", () => {
	it("writes the agent-attributed OSC 777 marker for each event", () => {
		const output = { write: vi.fn(() => true) };

		emitHostStatus("working", output);
		emitHostStatus("attention", output);
		emitHostStatus("finished", output);

		expect(output.write).toHaveBeenNthCalledWith(1, "\x1b]777;notify;Terax;gjc;working\x07");
		expect(output.write).toHaveBeenNthCalledWith(2, "\x1b]777;notify;Terax;gjc;attention\x07");
		expect(output.write).toHaveBeenNthCalledWith(3, "\x1b]777;notify;Terax;gjc;finished\x07");
	});

	it("reports without asking the host to identify itself", () => {
		const previous = process.env.TERAX_TERMINAL;
		delete process.env.TERAX_TERMINAL;
		const output = { write: vi.fn(() => true) };

		emitHostStatus("finished", output);

		expect(output.write).toHaveBeenCalledTimes(1);
		if (previous !== undefined) process.env.TERAX_TERMINAL = previous;
	});

	it("emits a self-terminating OSC that carries no cursor movement", () => {
		const output = { write: vi.fn((_value: string) => true) };

		emitHostStatus("working", output);

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

		expect(() => emitHostStatus("finished", output)).not.toThrow();
		expect(output.write).toHaveBeenCalledTimes(1);
	});
});
