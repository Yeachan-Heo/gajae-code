import { describe, expect, it } from "bun:test";
import {
	consumeCapabilityInput,
	ItermPetTransport,
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
