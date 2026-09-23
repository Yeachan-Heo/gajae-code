import { describe, expect, it } from "bun:test";
import {
	consumeCapabilityInput,
	createNativePetTransport,
	ItermPetTransport,
	isItermCandidate,
	type NativePetUi,
	type PetTmuxResult,
	type PetTmuxRunner,
	type PetTransportClock,
} from "@gajae-code/coding-agent/modes/components/iterm-pet-transport";

const clock: PetTransportClock = {
	now: () => 0,
	setTimeout: () => 0,
	clearTimeout: () => {},
};

class Input {
	readonly listeners = new Set<(data: string | Uint8Array) => unknown>();
	async drain() {}
	onData = (callback: (data: string | Uint8Array) => unknown) => {
		this.listeners.add(callback);
		return () => this.listeners.delete(callback);
	};
	send(data: string) {
		for (const listener of this.listeners) listener(data);
	}
}

function make(topology: () => Promise<{ clients: number; paneId?: string; ownedPaneId?: string; clientId?: string }>) {
	const input = new Input();
	const events: Array<{ available: boolean; reason?: string; epoch: number }> = [];
	const transport = new ItermPetTransport({
		mode: "managed",
		clock,
		input,
		output: {
			write: async () => ({ status: "written" as const }),
		},
		tmux: async argv => {
			if (argv[0] === "show-options" && argv.includes("-q")) return { status: 0, stdout: "" };
			if (argv[0] === "show-options" && argv.includes("-A")) return { status: 0, stdout: "on" };
			return { status: 0, stdout: "" };
		},
		paneId: "%1",
		topology,
	});
	transport.subscribe(availability => {
		events.push({ available: availability.available, reason: availability.reason, epoch: availability.epoch });
	});
	return { events, input, transport };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let turn = 0; turn < 200; turn++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("condition did not become true within 200 microtasks");
}

function makeRefreshFixture(tmux: PetTmuxRunner, transportClock = clock) {
	const input = new Input();
	const transport = new ItermPetTransport({
		mode: "managed",
		clock: transportClock,
		input,
		output: { write: async () => ({ status: "written" as const }) },
		tmux,
		paneId: "%1",
		expectedClientId: "@1",
		topology: async () => ({ clients: 1, paneId: "%1", ownedPaneId: "%1", clientId: "@1" }),
	});
	return {
		input,
		transport,
		async ready() {
			const probe = transport.inspectManagedTopology();
			await waitFor(() => input.listeners.size === 1);
			input.send("\x1b]1337;Capabilities=F\x07");
			await probe;
		},
	};
}

function pendingCursorCommand(started: { resolve: () => void }, aborted: { resolve: () => void }) {
	let commandSignal: AbortSignal | undefined;
	const tmux: PetTmuxRunner = async (argv, signal) => {
		if (argv[0] === "show-options" && argv.includes("-q")) return { status: 0, stdout: "" };
		if (argv[0] === "show-options" && argv.includes("-A")) return { status: 0, stdout: "on" };
		if (argv[0] === "set-option") return { status: 0, stdout: "" };
		if (argv[0] === "display-message") {
			commandSignal = signal;
			started.resolve();
			const result = Promise.withResolvers<PetTmuxResult>();
			const onAbort = () => {
				aborted.resolve();
				result.resolve({ status: 1, stdout: "" });
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			return result.promise;
		}
		return { status: 0, stdout: "" };
	};
	return { tmux, getCommandSignal: () => commandSignal };
}

const nativeUi = {
	drainInput: async () => {},
	addInputListener: () => () => {},
	submitTerminalOutput: async () => ({ status: "written" }),
	notifyTerminalLifecycle: async () => {},
	terminalGeneration: 1,
} satisfies NativePetUi;

describe("iTerm Pet candidate detection", () => {
	it.each([
		["forwarded LC_TERMINAL", { SSH_CONNECTION: "client server", LC_TERMINAL: "iTerm2" }],
		["normalized LC_TERMINAL", { SSH_CONNECTION: "client server", LC_TERMINAL: " iterm2 " }],
		["forwarded TERM_PROGRAM", { SSH_TTY: "/dev/pts/1", TERM_PROGRAM: "iTerm.app" }],
		["normalized TERM_PROGRAM", { SSH_CLIENT: "10.0.0.1 12345 22", TERM_PROGRAM: " iTerm2 " }],
		["local iTerm2", { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.11" }],
	] as const)("probes %s without treating the environment marker as proof", (_label, env) => {
		expect(isItermCandidate(env, true)).toBe(true);
		const transport = createNativePetTransport({ ui: nativeUi, env, tty: true });
		expect(transport).toBeDefined();
		expect(transport?.availability.available).toBe(false);
		transport?.dispose();
	});

	it("does not treat whitespace-only markers as iTerm2 hints", () => {
		expect(isItermCandidate({ SSH_CONNECTION: "   ", LC_TERMINAL: "\t" }, true)).toBe(false);
		expect(isItermCandidate({ SSH_CLIENT: "\t", TERM_PROGRAM: "  " }, true)).toBe(false);
	});

	it.each([
		["generic SSH", { SSH_CONNECTION: "client server", TERM: "xterm-256color" }, true],
		["spoofed noninteractive marker", { SSH_CONNECTION: "client server", LC_TERMINAL: "iTerm2" }, false],
		["CI with a forwarded marker", { CI: "true", SSH_CONNECTION: "client server", LC_TERMINAL: "iTerm2" }, true],
		["whitespace-only CI", { CI: "   ", TERM_PROGRAM: "iTerm.app" }, true],
		["control-only CI", { CI: "\n\t", TERM_PROGRAM: "iTerm.app" }, true],
	] as const)("does not probe %s", (_label, env, tty) => {
		expect(isItermCandidate(env, tty)).toBe(false);
		expect(createNativePetTransport({ ui: nativeUi, env, tty })).toBeUndefined();
	});

	it.each([
		["explicit false CI", { CI: " false ", TERM_PROGRAM: "iTerm.app" }],
		["explicit zero CI", { CI: " 0 ", TERM_PROGRAM: "iTerm.app" }],
	] as const)("allows explicitly inactive CI marker %s", (_label, env) => {
		expect(isItermCandidate(env, true)).toBe(true);
	});

	it.each([
		["tmux", { TMUX: "/tmp/tmux-1/default,1,0" }],
		["screen", { STY: "screen.1" }],
		["zellij", { ZELLIJ: "1" }],
	] as const)("blocks unverified iTerm graphics inside %s", (_label, nesting) => {
		const env = { SSH_CONNECTION: "client server", LC_TERMINAL: "iTerm2", ...nesting };
		expect(createNativePetTransport({ ui: nativeUi, env, tty: true })).toBeUndefined();
	});
});

describe("managed iTerm Pet topology revocation", () => {
	it.each([
		["zero clients", 0, "zero-client-recovery"],
		["multiple clients", 2, "topology-ineligible"],
	] as const)("does not repeat the unavailable event for %s", async (_label, clients, reason) => {
		const x = make(async () => ({ clients }));

		await x.transport.inspectManagedTopology();
		await x.transport.inspectManagedTopology();

		expect(x.events).toEqual([{ available: false, reason, epoch: 1 }]);
		expect(x.transport.availability).toMatchObject({ available: false, reason, epoch: 1 });
	});

	it("emits changed-reason, recovery, and later revocation transitions", async () => {
		let clients = 0;
		const x = make(async () => (clients === 1 ? { clients: 1, paneId: "%1", ownedPaneId: "%1" } : { clients }));

		await x.transport.inspectManagedTopology();
		clients = 2;
		await x.transport.inspectManagedTopology();
		clients = 1;
		const recovery = x.transport.inspectManagedTopology();
		await waitFor(() => x.input.listeners.size === 1);
		x.input.send("\x1b]1337;Capabilities=F\x07");
		expect((await recovery).available).toBe(true);

		expect(x.events).toEqual([
			{ available: false, reason: "zero-client-recovery", epoch: 1 },
			{ available: false, reason: "topology-ineligible", epoch: 2 },
			{ available: false, reason: "topology-ineligible", epoch: 3 },
			{ available: true, reason: undefined, epoch: 3 },
		]);

		clients = 2;
		await x.transport.inspectManagedTopology();
		await x.transport.inspectManagedTopology();
		expect(x.events.at(-1)).toEqual({ available: false, reason: "topology-ineligible", epoch: 4 });
		expect(x.events).toHaveLength(5);
	});
});

describe("managed iTerm Pet cursor refresh cancellation", () => {
	it("aborts a pending cursor command when its TUI lifecycle ends", async () => {
		const commandStarted = Promise.withResolvers<void>();
		const commandAborted = Promise.withResolvers<void>();
		const command = pendingCursorCommand(commandStarted, commandAborted);
		const fixture = makeRefreshFixture(command.tmux);
		await fixture.ready();

		const lifecycle = new AbortController();
		const refresh = fixture.transport.refreshManagedClient(1, 2, lifecycle.signal);
		await commandStarted.promise;
		lifecycle.abort();

		expect(await refresh).toBe(false);
		await commandAborted.promise;
		expect(command.getCommandSignal()?.aborted).toBe(true);
		await fixture.transport.dispose();
	});

	it("aborts a pending cursor command when the refresh deadline expires", async () => {
		const timers = new Map<number, { callback: () => void; ms: number }>();
		let nextTimerId = 0;
		const timeoutClock: PetTransportClock = {
			now: () => 0,
			setTimeout: (callback, ms) => {
				const id = ++nextTimerId;
				timers.set(id, { callback, ms });
				return id;
			},
			clearTimeout: handle => {
				if (typeof handle === "number") timers.delete(handle);
			},
		};
		const commandStarted = Promise.withResolvers<void>();
		const commandAborted = Promise.withResolvers<void>();
		const command = pendingCursorCommand(commandStarted, commandAborted);
		const fixture = makeRefreshFixture(command.tmux, timeoutClock);
		await fixture.ready();

		const refresh = fixture.transport.refreshManagedClient(1, 2);
		await commandStarted.promise;
		const timeout = [...timers.values()].find(timer => timer.ms === 250);
		if (!timeout) throw new Error("managed cursor refresh timeout was not scheduled");
		timeout.callback();

		expect(await refresh).toBe(false);
		await commandAborted.promise;
		expect(command.getCommandSignal()?.aborted).toBe(true);
		await fixture.transport.dispose();
	});
});

describe("capability input fragmentation", () => {
	it.each([
		["immediately after the ESC byte", "abcde\x1b", "]1337;Capabilities=F\x07", "abcde"],
		["after two marker bytes", "abc\x1b]", "1337;Capabilities=F\x07", "abc"],
		["after a long marker prefix", "xx\x1b]1337", ";Capabilities=F\x07", "xx"],
		["with the marker alone in the first chunk", "\x1b]1337", ";Capabilities=F\x07", ""],
		["before the ST terminator", "\x1b]1337;Capabilities=F\x1b", "\\", ""],
	] as const)("captures the reply when it is split %s", (_label, firstChunk, secondChunk, expectedPassthrough) => {
		const captured: string[] = [];
		const consume = consumeCapabilityInput(data => captured.push(String(data)));

		const first = consume(firstChunk);
		if (expectedPassthrough) expect(first?.data).toBe(expectedPassthrough);
		else expect(first?.consume ?? first === undefined).toBeTruthy();

		const second = consume(secondChunk);
		expect(second?.consume ?? second === undefined).toBeTruthy();
		expect(captured).toEqual([
			secondChunk === "\\" ? "\x1b]1337;Capabilities=F\x1b\\" : "\x1b]1337;Capabilities=F\x07",
		]);
	});

	it("forwards ordinary input unchanged and keeps unrelated escape replies", () => {
		const captured: string[] = [];
		const consume = consumeCapabilityInput(data => captured.push(String(data)));
		expect(consume("hello world")?.data).toBe("hello world");
		expect(consume("\x1b[97;1u")?.data).toBe("\x1b[97;1u");
		expect(consume("\x1b]11;rgb:1234/1234/1234\x1b\\")?.data).toBe("\x1b]11;rgb:1234/1234/1234\x1b\\");
		expect(consume("\x1b[?62;22;52c")?.data ?? "pass").toBeTruthy();
		expect(captured).toEqual([]);
	});

	it("captures every complete frame and passes interleaved text through", () => {
		const captured: string[] = [];
		const consume = consumeCapabilityInput(data => captured.push(String(data)));
		expect(consume("\x1b]1337;Capabilities=F\x07xy\x1b]1337;Capabilities=x\x07")?.data).toBe("xy");
		expect(captured).toEqual(["\x1b]1337;Capabilities=F\x07", "\x1b]1337;Capabilities=x\x07"]);
	});
});
