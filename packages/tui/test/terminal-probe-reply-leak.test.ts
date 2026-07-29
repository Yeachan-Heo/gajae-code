/**
 * Terminal capability-probe replies (OSC 11 background color, the DA1 sentinel,
 * the sixel XTSMGRAPHICS report) must never be typed into the focused component,
 * however the terminal chops them across stdin reads and however long ago the
 * query that solicited them was issued.
 *
 * Regression: after a long-running foreground command the terminal owes replies
 * whose pending-query state was already reset, and those replies arrive split
 * across reads. Both conditions routed the reply into the editor, which showed up
 * as `^[]11;rgb:0000/0000/0000^G^[[?62;22;52c` typed into the prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Component } from "@gajae-code/tui";
import { TUI } from "@gajae-code/tui";
import { ProcessTerminal } from "@gajae-code/tui/terminal";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

const OSC11_REPLY = "\x1b]11;rgb:0000/0000/0000\x07";
const DA1_REPLY = "\x1b[?62;22;52c";
const REPLY_PAIR = `${OSC11_REPLY}${DA1_REPLY}`;
/** DA1 is forwarded by ProcessTerminal on purpose: `Tui` owns that reply. */
const DA1_PATTERN = /^\x1b\[\?[\d;]*c$/u;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function mockTty(): void {
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
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
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Feed `text` to stdin in `chunk`-sized reads separated by `gap` ms. */
async function feed(text: string, chunk: number, gap: number): Promise<void> {
	for (let i = 0; i < text.length; i += chunk) {
		process.stdin.emit("data", Buffer.from(text.slice(i, i + chunk)));
		if (gap > 0) await sleep(gap);
	}
	// Past every hold/flush bound so nothing is still buffered.
	await sleep(700);
}

describe("ProcessTerminal probe-reply leaks", () => {
	let terminal: ProcessTerminal | undefined;
	let received: string[] = [];

	beforeEach(() => {
		mockTty();
		received = [];
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

	/** Everything the terminal forwards must be a whole DA1 reply, never a fragment. */
	function expectNoLeak(extra: string[] = []): void {
		const leaked = received.filter(sequence => !DA1_PATTERN.test(sequence) && !extra.includes(sequence));
		expect(leaked).toEqual([]);
		for (const sequence of extra) expect(received).toContain(sequence);
	}

	it("drops a whole-sequence reply flood", async () => {
		await feed(REPLY_PAIR.repeat(4), REPLY_PAIR.length, 0);
		expectNoLeak();
	});

	// The gaps below exceed StdinBuffer's 10ms completion timeout, which is what a
	// busy event loop during a long foreground command produces.
	it.each([
		[1, 12],
		[7, 15],
		[23, 25],
	])("drops a reply flood split into %i-byte reads %i ms apart", async (chunk, gap) => {
		await feed(REPLY_PAIR.repeat(4), chunk, gap);
		expectNoLeak();
	});

	it("drops replies that outlived a stop()/start() cycle", async () => {
		// Consume the replies for the query start() issued, then restart: the probe
		// counters are reset while the terminal still owes the queued replies.
		process.stdin.emit("data", Buffer.from(REPLY_PAIR));
		terminal!.stop();
		received = [];
		terminal!.start(
			data => received.push(data),
			() => {},
		);

		await feed(REPLY_PAIR.repeat(3), 9, 15);
		expectNoLeak();
	});

	it("still delivers real keys interleaved with a reply flood", async () => {
		await feed(`${REPLY_PAIR.repeat(2)}x${REPLY_PAIR}`, 5, 12);
		expectNoLeak(["x"]);
	});

	it("still delivers a split arrow key", async () => {
		await feed("\x1b[A", 1, 12);
		expectNoLeak(["\x1b[A"]);
	});

	it("still delivers a bare escape key", async () => {
		await feed("\x1b", 1, 0);
		expectNoLeak(["\x1b"]);
	});
});

describe("Tui probe-reply leaks", () => {
	let tui: TUI | undefined;
	let received: string[] = [];

	const sink: Component = {
		render: () => [],
		handleInput: data => {
			received.push(data);
		},
		invalidate: () => {},
	};

	beforeEach(() => {
		mockTty();
		received = [];
		tui = new TUI(new ProcessTerminal());
		tui.start();
		tui.setFocus(sink);
	});

	afterEach(() => {
		tui?.stop();
		tui = undefined;
		restoreTty();
	});

	/**
	 * Resolve the startup sixel probe (DA1 + XTSMGRAPHICS) so its input listener
	 * unsubscribes. Replies after this point are orphaned, which is the state a
	 * session reaches within its first minutes.
	 */
	async function settleStartupProbes(): Promise<void> {
		process.stdin.emit("data", Buffer.from("\x1b[?1;2c\x1b[?2;0;800;480S"));
		await sleep(60);
		received = [];
	}

	it("still hands the sixel probe its own DA1 reply", async () => {
		const seen: string[] = [];
		tui!.addInputListener(data => {
			seen.push(data);
			return undefined;
		});

		// A real terminal answers both DA1 requests: ProcessTerminal's OSC 11 sentinel
		// and the sixel probe's own `CSI c`. The first is swallowed as the sentinel, the
		// second must reach the probe listener.
		process.stdin.emit("data", Buffer.from("\x1b[?1;2c\x1b[?1;2c\x1b[?2;0;800;480S"));
		await sleep(60);

		expect(seen).toContain("\x1b[?1;2c");
		expect(seen).toContain("\x1b[?2;0;800;480S");
	});

	it("never types an orphaned probe reply into the focused component", async () => {
		await settleStartupProbes();
		await feed(REPLY_PAIR.repeat(4), 7, 15);
		expect(received).toEqual([]);
	});

	it("drops an orphaned DA1 reply", async () => {
		await settleStartupProbes();
		await feed(DA1_REPLY, DA1_REPLY.length, 0);
		expect(received).toEqual([]);
	});

	it("drops an orphaned sixel XTSMGRAPHICS report", async () => {
		await settleStartupProbes();
		await feed("\x1b[?2;0;800;480S", 4, 15);
		expect(received).toEqual([]);
	});

	it("still delivers real keys", async () => {
		await settleStartupProbes();
		await feed("hi", 1, 12);
		expect(received).toEqual(["h", "i"]);
	});
});
