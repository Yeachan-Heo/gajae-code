import { afterEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal, TerminalResponseRegistry } from "@gajae-code/tui/terminal";

const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

type Match = { start: number; end: number; value: string };

function parser(pattern: RegExp, partial: RegExp) {
	return (buffer: string): { frame?: Match; partialStart?: number } => {
		const complete = pattern.exec(buffer);
		const prefix = partial.exec(buffer);
		if (complete && (!prefix || complete.index <= prefix.index)) {
			return {
				frame: {
					start: complete.index,
					end: complete.index + complete[0].length,
					value: complete[1] ?? complete[0],
				},
			};
		}
		return prefix ? { partialStart: prefix.index } : {};
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (stdinSetRawModeDescriptor) {
		Object.defineProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	} else {
		delete (process.stdin as unknown as Record<string, unknown>).setRawMode;
	}
});

describe("ProcessTerminal response boundary", () => {
	it("forwards an expired partial response through input handling once", () => {
		vi.useFakeTimers();
		const received: string[] = [];
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(() => process.stdin), configurable: true });
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const terminal = new ProcessTerminal();
		terminal.start(
			data => received.push(data),
			() => {},
		);
		terminal.registerResponse({
			id: "test.expiring",
			expiresInMs: 20,
			parse: buffer => {
				const start = buffer.indexOf("\x1b]42;");
				if (start < 0) return {};
				const terminator = buffer.indexOf("\x07", start);
				if (terminator < 0) return { partialStart: start };
				return {
					frame: {
						start,
						end: terminator + 1,
						value: buffer.slice(start, terminator + 1),
					},
				};
			},
			onComplete: () => {},
		});

		process.stdin.emit("data", "\x1b]42;partial");
		vi.advanceTimersByTime(10);
		expect(received).toEqual([]);

		vi.advanceTimersByTime(10);
		expect(received).toEqual(["\x1b]42;partial"]);

		terminal.stop();
		expect(received).toEqual(["\x1b]42;partial"]);
	});
});

describe("TerminalResponseRegistry", () => {
	it("consumes only a complete frame for an armed request", () => {
		const completed: string[] = [];
		const registry = new TerminalResponseRegistry();
		registry.arm({
			id: "probe",
			parse: parser(/\x1b\[\?([\d;]+)c/u, /\x1b\[\?[\d;]*$/u),
			onComplete: value => completed.push(value),
		});

		expect(registry.consume("typed\x1b[?62")).toBe("typed");
		expect(registry.consume(";6c")).toBe("");
		expect(completed).toEqual(["62;6"]);
		expect(registry.pendingCount).toBe(0);
		expect(registry.consume("\x1b[?1;2c")).toBe("\x1b[?1;2c");
	});

	it("forwards an interrupted partial frame and preserves the new escape", () => {
		const registry = new TerminalResponseRegistry();
		registry.arm({
			id: "probe",
			parse: parser(/\x1b\[\?([\d;]+)c/u, /\x1b\[\?[\d;]*$/u),
			onComplete: () => {},
		});

		expect(registry.consume("\x1b[?62")).toBe("");
		expect(registry.consume("\x1b[A")).toBe("\x1b[?62\x1b[A");
	});

	it("chooses the earliest frame, then priority, then arm order", () => {
		const completed: string[] = [];
		const registry = new TerminalResponseRegistry();
		const response = (id: string, priority: number, value: string) => ({
			id,
			priority,
			parse: parser(new RegExp("\\x1b\\[\\?" + value + "u", "u"), /a^/u),
			onComplete: () => completed.push(id),
		});
		registry.arm(response("low", 1, "1"));
		registry.arm(response("high", 2, "1"));
		registry.arm(response("later", 3, "2"));

		expect(registry.consume("x\x1b[?1u\x1b[?2u")).toBe("x");
		expect(completed).toEqual(["high", "later"]);
	});

	it("forwards buffered bytes when a request expires", () => {
		vi.useFakeTimers();
		const forwarded: string[] = [];
		const expired: string[] = [];
		const registry = new TerminalResponseRegistry({ onForward: data => forwarded.push(data) });
		registry.arm({
			id: "probe",
			expiresInMs: 20,
			parse: parser(/\x1b\[\?([\d;]+)c/u, /\x1b\[\?[\d;]*$/u),
			onComplete: () => {},
			onExpire: () => expired.push("expired"),
		});

		expect(registry.consume("\x1b[?62")).toBe("");
		vi.advanceTimersByTime(20);
		expect(expired).toEqual(["expired"]);
		expect(forwarded).toEqual(["\x1b[?62"]);
		expect(registry.pendingCount).toBe(0);
	});

	it("flushes and disarms when the raw buffer exceeds its bound", () => {
		const registry = new TerminalResponseRegistry({ maxBytes: 64 });
		registry.arm({
			id: "probe",
			parse: parser(/\x1b\[\?([\d;]+)c/u, /\x1b\[\?[\d;]*$/u),
			onComplete: () => {},
		});
		const input = "\x1b[?" + "1".repeat(80);

		expect(registry.consume(input)).toBe(input);
		expect(registry.pendingCount).toBe(0);
	});
});
