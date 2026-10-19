import { afterEach, describe, expect, it, vi } from "bun:test";
import { emitHostStatus } from "@gajae-code/coding-agent/modes/utils/host-status";

const TERAX_ENV = "TERAX_TERMINAL";

/**
 * Run `run` with `name` set to `value` (deleted when `value` is `undefined`) and
 * restore the previous value afterwards so tests do not leak environment state
 * into each other.
 */
function withEnv(name: string, value: string | undefined, run: () => void): void {
	const previous = process.env[name];
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
	try {
		run();
	} finally {
		if (previous === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = previous;
		}
	}
}

function withTeraxHost<T>(run: () => T): T {
	const previous = process.env[TERAX_ENV];
	process.env[TERAX_ENV] = "1";
	try {
		return run();
	} finally {
		if (previous === undefined) {
			delete process.env[TERAX_ENV];
		} else {
			process.env[TERAX_ENV] = previous;
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

	it("emits for any non-empty Terax host marker, not just the literal 1", () => {
		const output = { write: vi.fn(() => true) };

		withEnv(TERAX_ENV, "terax", () => {
			emitHostStatus("working", output);
		});

		expect(output.write).toHaveBeenCalledTimes(1);
		expect(output.write).toHaveBeenCalledWith("\x1b]777;notify;Terax;gjc;working\x07");
	});

	it("stays silent in a terminal that is not Terax", () => {
		const output = { write: vi.fn(() => true) };

		withEnv(TERAX_ENV, undefined, () => {
			emitHostStatus("finished", output);
		});

		// OSC 777 `notify;` is the rxvt extension: terminals that implement it
		// show a desktop notification instead of discarding the sequence.
		expect(output.write).not.toHaveBeenCalled();
	});

	it("stays silent when the Terax marker is empty", () => {
		const output = { write: vi.fn(() => true) };

		withEnv(TERAX_ENV, "", () => {
			emitHostStatus("working", output);
		});

		expect(output.write).not.toHaveBeenCalled();
	});

	it("reads the host marker at call time, not at module load time", () => {
		const output = { write: vi.fn(() => true) };

		// The TUI is long-lived, so the environment is consulted per event.
		withEnv(TERAX_ENV, undefined, () => {
			emitHostStatus("working", output);
		});
		withEnv(TERAX_ENV, "1", () => {
			emitHostStatus("attention", output);
		});
		withEnv(TERAX_ENV, undefined, () => {
			emitHostStatus("finished", output);
		});

		expect(output.write).toHaveBeenCalledTimes(1);
		expect(output.write).toHaveBeenCalledWith("\x1b]777;notify;Terax;gjc;attention\x07");
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
		// The introducer is the only escape byte: nothing after it moves the cursor.
		expect(written.indexOf("\x1b")).toBe(0);
		expect(written.split("\x1b").length - 1).toBe(1);
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
