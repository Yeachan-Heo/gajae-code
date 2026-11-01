import { afterEach, describe, expect, it, vi } from "bun:test";
import { emitHostStatus, hostStatusEnabled } from "@gajae-code/coding-agent/modes/utils/host-status";

const OPT_IN = { GJC_HOST_STATUS: "terax" } as NodeJS.ProcessEnv;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("host status markers", () => {
	it("writes the agent-attributed OSC 777 marker for each event when the host opted in", () => {
		const output = { write: vi.fn(() => true) };

		emitHostStatus("working", output, OPT_IN);
		emitHostStatus("attention", output, OPT_IN);
		emitHostStatus("finished", output, OPT_IN);

		expect(output.write).toHaveBeenNthCalledWith(1, "\x1b]777;notify;Terax;gjc;working\x07");
		expect(output.write).toHaveBeenNthCalledWith(2, "\x1b]777;notify;Terax;gjc;attention\x07");
		expect(output.write).toHaveBeenNthCalledWith(3, "\x1b]777;notify;Terax;gjc;finished\x07");
	});

	it("writes nothing when no host marker is set", () => {
		// OSC 777 is the rxvt notify extension: Ghostty and cmux raise a desktop
		// notification for it, so an unmarked host must receive no bytes at all.
		const output = { write: vi.fn(() => true) };

		for (const event of ["working", "attention", "finished"] as const)
			emitHostStatus(event, output, {} as NodeJS.ProcessEnv);

		expect(output.write).not.toHaveBeenCalled();
	});

	it("ignores a marker value that names a different host", () => {
		const output = { write: vi.fn(() => true) };

		emitHostStatus("working", output, { GJC_HOST_STATUS: "ghostty" } as NodeJS.ProcessEnv);

		expect(output.write).not.toHaveBeenCalled();
	});

	it("accepts the marker case-insensitively and with surrounding whitespace", () => {
		const output = { write: vi.fn(() => true) };

		emitHostStatus("working", output, { GJC_HOST_STATUS: "  Terax\n" } as NodeJS.ProcessEnv);

		expect(output.write).toHaveBeenCalledWith("\x1b]777;notify;Terax;gjc;working\x07");
	});

	it("reports whether a host opted in", () => {
		expect(hostStatusEnabled(OPT_IN)).toBe(true);
		expect(hostStatusEnabled({} as NodeJS.ProcessEnv)).toBe(false);
		expect(hostStatusEnabled({ GJC_HOST_STATUS: " " } as NodeJS.ProcessEnv)).toBe(false);
	});

	it("emits a self-terminating OSC that carries no cursor movement", () => {
		const output = { write: vi.fn((_value: string) => true) };

		emitHostStatus("working", output, OPT_IN);

		const written = output.write.mock.calls[0][0] as string;
		expect(written.startsWith("\x1b]")).toBe(true);
		expect(written.endsWith("\x07")).toBe(true);
		expect(written.slice(2, -1)).toMatch(/^[\x20-\x7e]*$/);
	});

	it("swallows write failures so a broken stdout can't abort a turn", () => {
		const output = {
			write: vi.fn(() => {
				throw new Error("EPIPE");
			}),
		};

		expect(() => emitHostStatus("finished", output, OPT_IN)).not.toThrow();
		expect(output.write).toHaveBeenCalledTimes(1);
	});
});
