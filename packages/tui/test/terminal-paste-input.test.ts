/**
 * ProcessTerminal re-wraps pastes, including an unmarked multi-line burst
 * (tmux `paste-buffer` without `-p`), so the editor receives one paste.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@gajae-code/tui/terminal";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const stdinIsRawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function mockTty(isRaw: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "isRaw", { value: isRaw, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	vi.spyOn(process, "kill").mockReturnValue(true);
	vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

function restoreTty(): void {
	vi.restoreAllMocks();
	restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
	restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
	restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	restoreProperty(process.stdin, "isRaw", stdinIsRawDescriptor);
}

describe("ProcessTerminal paste input", () => {
	let terminal: ProcessTerminal | undefined;
	let received: string[] = [];

	beforeEach(() => {
		received = [];
		mockTty(true);
		terminal = new ProcessTerminal();
		terminal.start(
			data => received.push(data),
			() => {},
		);
	});

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		restoreTty();
	});

	it("re-wraps a bracketed paste unchanged", () => {
		process.stdin.emit("data", Buffer.from("\x1b[200~pasted\x1b[201~"));
		expect(received).toEqual(["\x1b[200~pasted\x1b[201~"]);
	});

	it("delivers an unmarked multi-line burst as one re-wrapped paste", () => {
		process.stdin.emit("data", Buffer.from("a\nb\nc"));
		expect(received).toEqual(["\x1b[200~a\nb\nc\x1b[201~"]);
	});
});
