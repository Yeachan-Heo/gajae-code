import { describe, expect, it } from "bun:test";
import {
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
