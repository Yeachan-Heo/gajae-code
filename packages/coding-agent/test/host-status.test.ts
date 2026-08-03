import { afterEach, describe, expect, it, vi } from "bun:test";
import { emitHostStatus } from "@gajae-code/coding-agent/modes/utils/host-status";

const original = process.env.TERAX_TERMINAL;

afterEach(() => {
	if (original === undefined) delete process.env.TERAX_TERMINAL;
	else process.env.TERAX_TERMINAL = original;
	vi.restoreAllMocks();
});

describe("host status markers", () => {
	it("stays silent outside a host terminal", () => {
		delete process.env.TERAX_TERMINAL;
		const output = { write: vi.fn(() => true) };

		emitHostStatus("working", output);

		expect(output.write).not.toHaveBeenCalled();
	});

	it("writes the agent-attributed OSC 777 marker for each event", () => {
		process.env.TERAX_TERMINAL = "1";
		const output = { write: vi.fn(() => true) };

		emitHostStatus("working", output);
		emitHostStatus("attention", output);
		emitHostStatus("finished", output);

		expect(output.write).toHaveBeenNthCalledWith(1, "\x1b]777;notify;Terax;gjc;working\x07");
		expect(output.write).toHaveBeenNthCalledWith(2, "\x1b]777;notify;Terax;gjc;attention\x07");
		expect(output.write).toHaveBeenNthCalledWith(3, "\x1b]777;notify;Terax;gjc;finished\x07");
	});

	it("swallows write failures so a broken stdout can't abort a turn", () => {
		process.env.TERAX_TERMINAL = "1";
		const output = {
			write: vi.fn(() => {
				throw new Error("EPIPE");
			}),
		};

		expect(() => emitHostStatus("finished", output)).not.toThrow();
		expect(output.write).toHaveBeenCalledTimes(1);
	});
});
