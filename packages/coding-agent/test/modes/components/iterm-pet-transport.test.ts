import { describe, expect, it } from "bun:test";
import type { PetTmuxResult, PetTmuxRunner } from "@gajae-code/coding-agent/modes/components/iterm-pet-transport";
import {
	capabilityProbe,
	consumeCapabilityInput,
	createNativePetTransport,
	hasItermFileCapability,
	ItermPetTransport,
	isItermCandidate,
} from "@gajae-code/coding-agent/modes/components/iterm-pet-transport";

const ack = "\x1b]1337;Capabilities=F\x07";

class Clock {
	nowMs = 0;
	timers = new Map<number, { at: number; cb: () => void }>();
	next = 0;
	now = () => this.nowMs;
	setTimeout = (cb: () => void, ms: number) => {
		const id = ++this.next;
		this.timers.set(id, { at: this.nowMs + ms, cb });
		return id;
	};
	clearTimeout = (id: unknown) => {
		this.timers.delete(id as number);
	};
	advance(ms: number) {
		this.nowMs += ms;
		for (const [id, timer] of [...this.timers]) {
			if (timer.at <= this.nowMs) {
				this.timers.delete(id);
				timer.cb();
			}
		}
	}
}

const waitFor = async (predicate: () => boolean) => {
	for (let turns = 0; turns < 50; turns++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("condition did not become true within 50 microtasks");
};

class Input {
	listeners = new Set<(data: string | Uint8Array) => unknown>();
	drains: number[][] = [];
	drain = async (maxMs: number, quiescenceMs: number) => {
		this.drains.push([maxMs, quiescenceMs]);
	};
	onData = (callback: (data: string | Uint8Array) => unknown) => {
		this.listeners.add(callback);
		return () => this.listeners.delete(callback);
	};
	send(data: string | Uint8Array) {
		return [...this.listeners].map(callback => callback(data));
	}
}

const make = (extra: Partial<ConstructorParameters<typeof ItermPetTransport>[0]> = {}) => {
	const clock = new Clock();
	const input = new Input();
	const writes: Uint8Array[] = [];
	const output = {
		write: async (bytes: Uint8Array) => {
			writes.push(bytes);
			return { status: "written" as const };
		},
	};
	const transport = new ItermPetTransport({ clock, input, output, ...extra });
	return { clock, input, writes, transport };
};
const factoryUi = {
	drainInput: async () => {},
	addInputListener: () => () => {},
	submitTerminalOutput: async () => ({ status: "written" as const }),
	notifyTerminalLifecycle: async () => {},
	terminalGeneration: 1,
};

it("refreshes direct transport without invoking tmux", async () => {
	let calls = 0;
	const x = make({
		tmux: async () => {
			calls++;
			return { status: 0, stdout: "" };
		},
	});
	expect(await x.transport.refreshManagedClient(0, 0)).toBe(true);
	expect(calls).toBe(0);
});

describe("iTerm Pet transport factory", () => {
	it("creates managed transport for an eligible iTerm tmux session", () => {
		const transport = createNativePetTransport({
			ui: factoryUi,
			env: {
				TERM_PROGRAM: "iTerm.app",
				TERM_PROGRAM_VERSION: "3.7",
				TMUX_PANE: "%13",
				GJC_TMUX_ACTIVE_SESSION: "session",
				GJC_MANAGED_OWNER_RUN_ID: "run",
			},
		});
		expect(transport?.availability.mode).toBe("managed");
	});

	it("rejects tmux when a managed marker is missing", () => {
		const transport = createNativePetTransport({
			ui: factoryUi,
			env: {
				TERM_PROGRAM: "iTerm.app",
				TERM_PROGRAM_VERSION: "3.7",
				TMUX_PANE: "%13",
				GJC_TMUX_ACTIVE_SESSION: "session",
			},
		});
		expect(transport).toBeUndefined();
	});

	it("rejects unsupported direct terminals", () => {
		const transport = createNativePetTransport({
			ui: factoryUi,
			env: { TERM_PROGRAM: "xterm", TERM_PROGRAM_VERSION: "3.7" },
		});
		expect(transport).toBeUndefined();
	});
	it("covers direct candidate version boundaries through the factory seam", () => {
		expect(isItermCandidate({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.4.9" }, true)).toBe(false);
		expect(isItermCandidate({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.0" }, true)).toBe(true);
		expect(isItermCandidate({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "4.0.0" }, true)).toBe(true);
		expect(isItermCandidate({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.0" }, false)).toBe(false);
	});
});
describe("iTerm Pet transport", () => {
	const managedReady = async (
		tmux: (argv: readonly string[]) => Promise<{ status: number; stdout: string }>,
		topology: () => Promise<{
			clients: number;
			paneId: string;
			ownedPaneId: string;
			clientId: string;
		}> = async () => ({
			clients: 1,
			paneId: "%1",
			ownedPaneId: "%1",
			clientId: "client-1",
		}),
	) => {
		const x = make({
			mode: "managed",
			paneId: "%1",
			sessionTarget: "s",
			tmux,
			topology,
			expectedClientId: "client-1",
		});
		const probe = x.transport.inspectManagedTopology();
		await waitFor(() => x.input.listeners.size === 1);
		x.input.send(ack);
		await probe;
		return x;
	};
	it("observes rejected lifecycle notifications without changing completed availability", async () => {
		const notifications: string[] = [];
		const x = make({
			output: {
				write: async () => ({ status: "written" as const }),
				notifyLifecycle: async event => {
					notifications.push(event.kind);
					throw new Error("notification failed");
				},
			},
		});
		const probe = x.transport.probe();
		await waitFor(() => x.input.listeners.size === 1);
		x.input.send(ack);
		expect((await probe).available).toBe(true);
		await Promise.resolve();
		expect(x.transport.availability.available).toBe(true);
		expect(notifications).toEqual(["availability-restored"]);
	});
	it("contains synchronous lifecycle notification throws after availability completes", async () => {
		const notifications: string[] = [];
		const x = make({
			output: {
				write: async () => ({ status: "written" as const }),
				notifyLifecycle: event => {
					notifications.push(event.kind);
					throw new Error("notification failed");
				},
			},
		});
		const probe = x.transport.probe();
		await waitFor(() => x.input.listeners.size === 1);
		x.input.send(ack);
		expect((await probe).available).toBe(true);
		expect(x.transport.availability.available).toBe(true);
		expect(notifications).toEqual(["availability-restored"]);
	});
	it("accepts official feature tokens after a written probe ack, including fragmented replies", async () => {
		const live = "\x1b]1337;Capabilities=T3CwLrMSc7UUw9Ts3BFGsSyHNoSxFP\x07";
		expect(hasItermFileCapability(live)).toBe(true);
		expect(hasItermFileCapability("\x1b]1337;Capabilities=T3CwLrMSc7UUw9Ts3B\x07")).toBe(false);
		expect(hasItermFileCapability("\x1b]1337;Capabilities=Ffoo\x07")).toBe(false);
		expect(hasItermFileCapability("\x1b]1337;Capabilities=Gx!\x07")).toBe(false);
		expect(hasItermFileCapability("\x1b]1337;Capabilities=F\x1b\\")).toBe(true);
		const x = make();
		const probe = x.transport.probe();
		await waitFor(() => x.input.listeners.size === 1);
		expect(x.writes).toHaveLength(1);
		x.input.send("\x1b]1337;Cap");
		expect(x.transport.availability.reason).toBeUndefined();
		x.input.send("abilities=T3CwLrMSc7UUw9Ts3BFGsSyHNoSxFP\x07");
		expect((await probe).available).toBe(true);
		expect(capabilityProbe()).toEqual(new TextEncoder().encode("\x1b]1337;Capabilities\x07"));
		expect(x.input.drains).toEqual([[100, 25]]);
	});
	it("rejects a synchronous capability reply from output.write until the written ack, then accepts post-ack input", async () => {
		const clock = new Clock();
		const input = new Input();
		let resolveWrite!: (result: { status: "written" }) => void;
		const output = {
			write: async () => {
				input.send(ack);
				return new Promise<{ status: "written" }>(resolve => {
					resolveWrite = resolve;
				});
			},
		};
		const transport = new ItermPetTransport({ clock, input, output });
		const probe = transport.probe();
		await Promise.resolve();
		expect(transport.availability.available).toBe(false);
		resolveWrite({ status: "written" });
		await waitFor(() => clock.timers.size === 1);
		await waitFor(() => input.listeners.size === 1);
		input.send(ack);
		expect((await probe).available).toBe(true);
		expect(input.listeners.size).toBe(0);
		expect(clock.timers.size).toBe(0);
	});
	it("cleans up after a failed capability write", async () => {
		const x = make({
			output: { write: async () => ({ status: "failed" as const }) },
		});
		expect((await x.transport.probe()).reason).toBe("probe-timeout");
		expect(x.input.listeners.size).toBe(0);
		expect(x.clock.timers.size).toBe(0);
	});
	it("preserves mixed user input while consuming only complete capability frames", () => {
		const frames: string[] = [];
		const split = consumeCapabilityInput(data =>
			frames.push(typeof data === "string" ? data : new TextDecoder().decode(data)),
		);
		expect(split(`a${ack}b`)).toEqual({ data: "ab" });
		expect(frames).toEqual([ack]);
		expect(split("left")).toEqual({ data: "left" });
	});

	it("consumes pure complete and fragmented capability frames", () => {
		const split = consumeCapabilityInput(() => {});
		expect(split(ack)).toEqual({ consume: true });
		expect(split("\x1b]1337;Cap")).toEqual({ consume: true });
		expect(split("abilities=F\x07")).toEqual({ consume: true });
	});

	it("classifies completed replies as missing F only when syntax is valid", async () => {
		for (const [reply, reason] of [
			["\x1b]1337;Capabilities=T3CwLrMSc7UUw9Ts3B\x07", "missing-f"],
			["\x1b]1337;Capabilities=Gx!\x07", "invalid-f"],
		] as const) {
			const x = make();
			const probe = x.transport.probe();
			await waitFor(() => x.input.listeners.size === 1);
			x.input.send(reply);
			expect((await probe).reason).toBe(reason);
			expect(x.transport.availability.reason).toBe(reason);
		}
	});

	it("times out at 1000ms without retry and allows manual retry as a new epoch", async () => {
		const x = make();
		const probe = x.transport.probe();
		await waitFor(() => x.input.listeners.size === 1);
		x.clock.advance(999);
		expect(x.transport.availability.available).toBe(false);
		x.clock.advance(1);
		expect((await probe).reason).toBe("probe-timeout");
		const retry = x.transport.retry();
		await waitFor(() => x.input.listeners.size === 1);
		expect(x.transport.availability.epoch).toBe(2);
		x.input.send(ack);
		expect((await retry).available).toBe(true);
	});

	it("keeps one outstanding query", async () => {
		const x = make();
		const first = x.transport.probe();
		const second = x.transport.probe();
		await waitFor(() => x.input.listeners.size === 1);
		expect(x.writes).toHaveLength(1);
		x.input.send(ack);
		await first;
		expect((await second).available).toBe(false);
	});

	it("queries requested zero-based cursor coordinates and refreshes only on exact match", async () => {
		const calls: string[][] = [];
		const x = await managedReady(async argv => {
			calls.push([...argv]);
			if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "" };
			if (argv[0] === "display-message") return { status: 0, stdout: "4\t7" };
			return { status: 0, stdout: "on" };
		});
		expect(await x.transport.refreshManagedClient(4, 7)).toBe(true);
		expect(calls.slice(-2)).toEqual([
			["display-message", "-p", "-t", "%1", "#{cursor_y}\t#{cursor_x}"],
			["refresh-client", "-t", "client-1"],
		]);
	});

	it("retries stale cursor after 10ms and refreshes once on exact result", async () => {
		const calls: string[][] = [];
		let count = 0;
		const x = await managedReady(async argv => {
			calls.push([...argv]);
			if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "" };
			if (argv[0] === "display-message") return { status: 0, stdout: count++ === 0 ? "1\t2" : "3\t4" };
			return { status: 0, stdout: "on" };
		});
		const pending = x.transport.refreshManagedClient(3, 4);
		await waitFor(() => x.clock.timers.size === 1);
		x.clock.advance(9);
		expect(calls.filter(call => call[0] === "display-message")).toHaveLength(1);
		x.clock.advance(1);
		await waitFor(() => calls.filter(call => call[0] === "refresh-client").length === 1);
		expect(await pending).toBe(true);
		expect(calls.slice(-3)).toEqual([
			["display-message", "-p", "-t", "%1", "#{cursor_y}\t#{cursor_x}"],
			["display-message", "-p", "-t", "%1", "#{cursor_y}\t#{cursor_x}"],
			["refresh-client", "-t", "client-1"],
		]);
	});

	it("returns false after 250ms for stale cursor and never refreshes", async () => {
		const calls: string[][] = [];
		const x = await managedReady(async argv => {
			calls.push([...argv]);
			if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "" };
			if (argv[0] === "display-message") return { status: 0, stdout: "0\t1" };
			return { status: 0, stdout: "on" };
		});
		const pending = x.transport.refreshManagedClient(0, 0);
		await waitFor(() => x.clock.timers.size === 1);
		x.clock.advance(251);
		expect(await pending).toBe(false);
		expect(calls.some(call => call[0] === "refresh-client")).toBe(false);
	});

	it("returns false immediately for display errors and malformed cursor output", async () => {
		for (const output of [
			{ status: 1, stdout: "0\t0" },
			{ status: 0, stdout: "malformed" },
		]) {
			const calls: string[][] = [];
			const x = await managedReady(async argv => {
				calls.push([...argv]);
				if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "" };
				if (argv[0] === "display-message") return output;
				return { status: 0, stdout: "on" };
			});
			expect(await x.transport.refreshManagedClient(0, 0)).toBe(false);
			expect(calls.some(call => call[0] === "refresh-client")).toBe(false);
		}
	});

	it("fails when lifecycle or client validity changes during a cursor query", async () => {
		for (const change of ["lifecycle", "client"] as const) {
			let release!: (value: { status: number; stdout: string }) => void;
			let clientId = "client-1";
			const calls: string[][] = [];
			const x = await managedReady(
				async argv => {
					calls.push([...argv]);
					if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "" };
					if (argv[0] === "display-message")
						return new Promise(resolve => {
							release = resolve;
						});
					return { status: 0, stdout: "on" };
				},
				async () => ({ clients: 1, paneId: "%1", ownedPaneId: "%1", clientId }),
			);
			const pending = x.transport.refreshManagedClient(0, 0);
			await waitFor(() => release !== undefined);
			if (change === "lifecycle") await x.transport.revoke();
			else {
				clientId = "client-2";
				await x.transport.inspectManagedTopology();
			}
			release({ status: 0, stdout: "0\t0" });
			expect(await pending).toBe(false);
			expect(calls.some(call => call[0] === "refresh-client")).toBe(false);
		}
	});
	it("restores managed pane state with exact pane-only argv", async () => {
		const calls: string[][] = [];
		const tmux = async (argv: readonly string[]) => {
			calls.push([...argv]);
			if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "" };
			if (argv[0] === "display-message") return { status: 0, stdout: "0\t0" };
			return { status: 0, stdout: "on" };
		};
		const topology = async () => ({
			clients: 1,
			paneId: "%1",
			ownedPaneId: "%1",
			clientId: "client-1",
			clientVersion: "3.5.0",
		});
		const x = make({
			mode: "managed",
			paneId: "%1",
			sessionTarget: "s",
			tmux,
			topology,
			expectedClientId: "client-1",
		});
		const probe = x.transport.inspectManagedTopology();
		await waitFor(() => x.input.listeners.size === 1);
		expect(new TextDecoder().decode(x.writes[0])).toBe("\x1bPtmux;\x1b\x1b]1337;Capabilities\x07\x1b\\");
		x.input.send(ack);
		await probe;
		const refresh = x.transport.refreshManagedClient(0, 0);
		expect(calls).toHaveLength(4);
		await refresh;
		expect(calls).toHaveLength(5);
		expect(calls[3]).toEqual(["display-message", "-p", "-t", "%1", "#{cursor_y}\t#{cursor_x}"]);
		expect(calls[4]).toEqual(["refresh-client", "-t", "client-1"]);
		await x.transport.revoke();
		expect(calls).toEqual([
			["show-options", "-q", "-p", "-v", "-t", "%1", "allow-passthrough"],
			["set-option", "-p", "-t", "%1", "allow-passthrough", "on"],
			["show-options", "-A", "-p", "-v", "-t", "%1", "allow-passthrough"],
			["display-message", "-p", "-t", "%1", "#{cursor_y}\t#{cursor_x}"],
			["refresh-client", "-t", "client-1"],
			["set-option", "-u", "-p", "-t", "%1", "allow-passthrough"],
		]);
	});

	it("recovers after managed topology changes through zero clients", async () => {
		let clients = 1;
		const calls: string[][] = [];
		const tmux = async (argv: readonly string[]) => {
			calls.push([...argv]);
			if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "" };
			return { status: 0, stdout: "on" };
		};
		const x = make({ mode: "managed", paneId: "%1", sessionTarget: "s", tmux, topology: async () => ({ clients }) });
		const initial = x.transport.inspectManagedTopology();
		await waitFor(() => x.input.listeners.size === 1);
		x.input.send(ack);
		await initial;
		await x.transport.inspectManagedTopology();
		expect(x.transport.availability.available).toBe(true);
		expect(x.writes).toHaveLength(1);
		clients = 2;
		await x.transport.inspectManagedTopology();
		expect(x.transport.availability.reason).toBe("topology-ineligible");
		clients = 0;
		await x.transport.inspectManagedTopology();
		expect(x.transport.availability.reason).toBe("zero-client-recovery");
		clients = 1;
		const recovery = x.transport.inspectManagedTopology();
		await waitFor(() => x.input.listeners.size === 1);
		x.input.send(ack);
		const recovered = await recovery;
		if (recovered === undefined) throw new Error("managed topology recovery returned no availability");
		expect(recovered.available).toBe(true);
		expect(calls).toEqual([
			["show-options", "-q", "-p", "-v", "-t", "%1", "allow-passthrough"],
			["set-option", "-p", "-t", "%1", "allow-passthrough", "on"],
			["show-options", "-A", "-p", "-v", "-t", "%1", "allow-passthrough"],
			["set-option", "-u", "-p", "-t", "%1", "allow-passthrough"],
			["show-options", "-q", "-p", "-v", "-t", "%1", "allow-passthrough"],
			["set-option", "-p", "-t", "%1", "allow-passthrough", "on"],
			["show-options", "-A", "-p", "-v", "-t", "%1", "allow-passthrough"],
		]);
	});
	it("maps a live tmux client using client_name as the display target", async () => {
		const calls: string[][] = [];
		const tmux = async (argv: readonly string[]) => {
			calls.push([...argv]);
			if (argv[0] === "list-clients") return { status: 0, stdout: "/dev/ttys010\t/dev/ttys010\n" };
			if (argv[0] === "display-message") return { status: 0, stdout: "%1\n" };
			if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "" };
			return { status: 0, stdout: "on" };
		};
		const x = make({ mode: "managed", paneId: "%1", sessionTarget: "s", tmux });
		const probe = x.transport.inspectManagedTopology();
		await waitFor(() => x.input.listeners.size === 1);
		x.input.send(ack);
		expect((await probe).available).toBe(true);
		expect(calls).toEqual([
			["list-clients", "-t", "s", "-F", "#{client_name}\t#{client_tty}"],
			["display-message", "-p", "-t", "/dev/ttys010", "#{pane_id}"],
			["show-options", "-q", "-p", "-v", "-t", "%1", "allow-passthrough"],
			["set-option", "-p", "-t", "%1", "allow-passthrough", "on"],
			["show-options", "-A", "-p", "-v", "-t", "%1", "allow-passthrough"],
		]);
	});

	it("fails closed when tmux returns an empty client identity", async () => {
		const calls: string[][] = [];
		const tmux = async (argv: readonly string[]) => {
			calls.push([...argv]);
			return { status: 0, stdout: "\t/dev/ttys010\n" };
		};
		const x = make({ mode: "managed", paneId: "%1", sessionTarget: "s", tmux });
		const availability = await x.transport.inspectManagedTopology();
		expect(availability.reason).toBe("topology-ineligible");
		expect(calls).toEqual([["list-clients", "-t", "s", "-F", "#{client_name}\t#{client_tty}"]]);
	});
	it("serializes revoke restore behind deferred managed preparation", async () => {
		const calls: string[][] = [];
		let releasePrepare!: (value: { status: number; stdout: string }) => void;
		let releaseRestore!: (value: { status: number; stdout: string }) => void;
		const tmux: PetTmuxRunner = async (argv: readonly string[]) => {
			calls.push([...argv]);
			if (argv[0] === "set-option" && argv[1] === "-p") {
				return new Promise<PetTmuxResult>(resolve => {
					if (argv.at(-1) === "on") releasePrepare = resolve;
					else releaseRestore = resolve;
				});
			}
			return { status: 0, stdout: "off" };
		};
		const x = make({
			mode: "managed",
			paneId: "%1",
			sessionTarget: "s",
			tmux,
			topology: async () => ({ clients: 1, paneId: "%1", ownedPaneId: "%1", clientId: "client-1" }),
			expectedClientId: "client-1",
		});
		const pending = x.transport.inspectManagedTopology();
		await waitFor(() => releasePrepare !== undefined);
		const revoked = x.transport.revoke();
		expect(calls).toHaveLength(2);
		releasePrepare({ status: 0, stdout: "" });
		await waitFor(() => calls.length === 3);
		expect(calls[2]).toEqual(["set-option", "-p", "-t", "%1", "allow-passthrough", "off"]);
		releaseRestore({ status: 0, stdout: "" });
		await pending;
		await revoked;
		expect(calls).toEqual([
			["show-options", "-q", "-p", "-v", "-t", "%1", "allow-passthrough"],
			["set-option", "-p", "-t", "%1", "allow-passthrough", "on"],
			["set-option", "-p", "-t", "%1", "allow-passthrough", "off"],
		]);
	});
	it("restores before retrying after managed preparation rejection", async () => {
		const calls: string[][] = [];
		let failed = true;
		let releaseRestore!: (value: { status: number; stdout: string }) => void;
		const tmux: PetTmuxRunner = async (argv: readonly string[]) => {
			calls.push([...argv]);
			if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "off" };
			if (argv[0] === "set-option" && argv[1] === "-p" && failed) {
				failed = false;
				throw new Error("prepare failed");
			}
			if (argv[0] === "set-option" && argv[1] === "-p" && argv[4] === "allow-passthrough" && argv[5] === "off") {
				return new Promise<PetTmuxResult>(resolve => {
					releaseRestore = resolve;
				});
			}
			return { status: 0, stdout: "on" };
		};
		const { input, writes, transport } = make({
			mode: "managed",
			paneId: "%1",
			sessionTarget: "s",
			tmux,
			topology: async () => ({ clients: 1, paneId: "%1", ownedPaneId: "%1", clientId: "client-1" }),
			expectedClientId: "client-1",
		});
		const first = transport.inspectManagedTopology();
		await waitFor(() => releaseRestore !== undefined);
		expect(calls).toEqual([
			["show-options", "-q", "-p", "-v", "-t", "%1", "allow-passthrough"],
			["set-option", "-p", "-t", "%1", "allow-passthrough", "on"],
			["set-option", "-p", "-t", "%1", "allow-passthrough", "off"],
		]);
		releaseRestore({ status: 0, stdout: "" });
		expect((await first).available).toBe(false);
		const retry = transport.inspectManagedTopology();
		await waitFor(() => input.listeners.size === 1 && writes.length === 1);
		input.send(ack);
		expect((await retry).available).toBe(true);
		const restore = calls.findIndex(
			call => call[0] === "set-option" && call[1] === "-p" && call[4] === "allow-passthrough" && call[5] === "off",
		);
		const retryPrepare = calls.findIndex(
			(call, index) => index > restore && call[0] === "show-options" && call[1] === "-q",
		);
		expect(restore).toBeGreaterThanOrEqual(0);
		expect(retryPrepare).toBeGreaterThan(restore);
	});
	it("ignores stale topology completion without probing or mutating identity", async () => {
		let release!: (value: { clients: number; paneId: string; ownedPaneId: string; clientId: string }) => void;
		const x = make({
			mode: "managed",
			paneId: "%1",
			sessionTarget: "s",
			tmux: async () => ({ status: 0, stdout: "" }),
			topology: () => new Promise(resolve => (release = resolve)),
		});
		const pending = x.transport.inspectManagedTopology();
		await waitFor(() => release !== undefined);
		await x.transport.revoke();
		release({ clients: 1, paneId: "%2", ownedPaneId: "%2", clientId: "stale" });
		await pending;
		expect(x.writes).toHaveLength(0);
		expect(x.transport.availability.reason).toBe("topology-lost");
	});
});
it("retries cleanup after a thrown restore and retains the snapshot until success", async () => {
	const calls: string[][] = [];
	let attempts = 0;
	const x = make({
		mode: "managed",
		paneId: "%1",
		sessionTarget: "s",
		tmux: async argv => {
			calls.push([...argv]);
			if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "off" };
			if (argv[0] === "show-options" && argv[1] === "-A") return { status: 0, stdout: "on" };
			if (argv[0] === "set-option" && argv.at(-1) === "on") return { status: 0, stdout: "" };
			if (argv.at(-1) === "off" && attempts++ === 0) throw new Error("restore failed");
			return { status: 0, stdout: "" };
		},
		topology: async () => ({ clients: 1, paneId: "%1", ownedPaneId: "%1", clientId: "client-1" }),
		expectedClientId: "client-1",
	});
	const probe = x.transport.inspectManagedTopology();
	await waitFor(() => x.input.listeners.size === 1);
	x.input.send(ack);
	await probe;
	await x.transport.revoke();
	expect(x.transport.availability.reason).toBe("cleanup-failed");
	await x.transport.revoke("topology-ineligible");
	expect(x.transport.availability.reason).toBe("topology-ineligible");
	expect(calls.filter(argv => argv.at(-1) === "off")).toHaveLength(2);
	expect(calls.at(-1)).toEqual(["set-option", "-p", "-t", "%1", "allow-passthrough", "off"]);
});

it("retries cleanup after a nonzero restore and retains the snapshot until success", async () => {
	const calls: string[][] = [];
	let attempts = 0;
	const x = make({
		mode: "managed",
		paneId: "%1",
		sessionTarget: "s",
		tmux: async argv => {
			calls.push([...argv]);
			if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "off" };
			if (argv[0] === "show-options" && argv[1] === "-A") return { status: 0, stdout: "on" };
			if (argv[0] === "set-option" && argv.at(-1) === "on") return { status: 0, stdout: "" };
			if (argv.at(-1) === "off" && attempts++ === 0) return { status: 1, stdout: "" };
			return { status: 0, stdout: "" };
		},
		topology: async () => ({ clients: 1, paneId: "%1", ownedPaneId: "%1", clientId: "client-1" }),
		expectedClientId: "client-1",
	});
	const probe = x.transport.inspectManagedTopology();
	await waitFor(() => x.input.listeners.size === 1);
	x.input.send(ack);
	await probe;
	await x.transport.revoke();
	expect(x.transport.availability.reason).toBe("cleanup-failed");
	await x.transport.revoke();
	expect(x.transport.availability.reason).toBe("topology-lost");
	expect(calls.filter(argv => argv.at(-1) === "off")).toHaveLength(2);
	expect(calls.at(-1)).toEqual(["set-option", "-p", "-t", "%1", "allow-passthrough", "off"]);
});

it("coalesces concurrent restores while preserving the newer topology reason", async () => {
	const calls: string[][] = [];
	let release!: (value: { status: number; stdout: string }) => void;
	const x = make({
		mode: "managed",
		paneId: "%1",
		sessionTarget: "s",
		tmux: async argv => {
			calls.push([...argv]);
			if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "off" };
			if (argv[0] === "show-options" && argv[1] === "-A") return { status: 0, stdout: "on" };
			if (argv.at(-1) === "on") return { status: 0, stdout: "" };
			return new Promise<PetTmuxResult>(resolve => (release = resolve));
		},
		topology: async () => ({ clients: 1, paneId: "%1", ownedPaneId: "%1", clientId: "client-1" }),
		expectedClientId: "client-1",
	});
	const probe = x.transport.inspectManagedTopology();
	await waitFor(() => x.input.listeners.size === 1);
	x.input.send(ack);
	await probe;
	const first = x.transport.revoke("topology-lost");
	await waitFor(() => calls.filter(argv => argv.at(-1) === "off").length === 1);
	const second = x.transport.revoke("topology-ineligible");
	expect(calls.filter(argv => argv.at(-1) === "off")).toHaveLength(1);
	release({ status: 0, stdout: "" });
	await first;
	await second;
	expect(calls.filter(argv => argv.at(-1) === "off")).toHaveLength(1);
	expect(x.transport.availability.reason).toBe("topology-ineligible");
});

it("disposes only after restore and cannot restart listeners, timers, polling, or observers", async () => {
	const calls: string[][] = [];
	let release!: (value: { status: number; stdout: string }) => void;
	const x = make({
		mode: "managed",
		paneId: "%1",
		sessionTarget: "s",
		tmux: async argv => {
			calls.push([...argv]);
			if (argv[0] === "show-options" && argv[1] === "-q") return { status: 0, stdout: "off" };
			if (argv[0] === "show-options" && argv[1] === "-A") return { status: 0, stdout: "on" };
			if (argv.at(-1) === "on") return { status: 0, stdout: "" };
			return new Promise<PetTmuxResult>(resolve => (release = resolve));
		},
		topology: async () => ({ clients: 1, paneId: "%1", ownedPaneId: "%1", clientId: "client-1" }),
		expectedClientId: "client-1",
	});
	const probe = x.transport.inspectManagedTopology();
	await waitFor(() => x.input.listeners.size === 1);
	x.input.send(ack);
	await probe;
	const disposing = x.transport.dispose();
	await waitFor(() => calls.filter(argv => argv.at(-1) === "off").length === 1);
	expect(x.input.listeners.size).toBe(0);
	release({ status: 0, stdout: "" });
	await disposing;
	const count = calls.length;
	x.input.send(ack);
	x.clock.advance(10000);
	expect(calls).toHaveLength(count);
	expect(x.input.listeners.size).toBe(0);
	expect(x.clock.timers.size).toBe(0);
});
