import { describe, expect, test } from "bun:test";
import { type RpcControlClock, type RpcControlSignal, RpcControlStateMachine } from "../src/rpc-control-state";
import type { RpcBackendPort, RpcBackendState } from "../src/types";

class FakeClock implements RpcControlClock {
	#next = 1;
	timers = new Map<unknown, () => void>();

	setTimeout(callback: () => void): unknown {
		const id = this.#next++;
		this.timers.set(id, callback);
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle);
	}

	fireAll(): void {
		const timers = [...this.timers.values()];
		this.timers.clear();
		for (const timer of timers) timer();
	}
}

class FakeBackend implements RpcBackendPort {
	calls: Array<{ method: string; args?: unknown }> = [];
	state: RpcBackendState = { connected: true, socketPath: "/tmp/gjc.sock", session: { status: "idle" } };
	deferPrompt = false;
	#deferredPrompt: (() => void) | null = null;

	async connect(): Promise<void> {
		this.calls.push({ method: "connect" });
	}

	async close(): Promise<void> {
		this.calls.push({ method: "close" });
	}

	async getState(): Promise<RpcBackendState> {
		this.calls.push({ method: "getState" });
		return this.state;
	}

	async prompt(message: string): Promise<void> {
		this.calls.push({ method: "prompt", args: message });
		if (this.deferPrompt) await new Promise<void>(resolve => (this.#deferredPrompt = resolve));
	}

	resolvePrompt(): void {
		this.#deferredPrompt?.();
		this.#deferredPrompt = null;
	}

	async steer(message: string): Promise<void> {
		this.calls.push({ method: "steer", args: message });
	}

	async abort(): Promise<void> {
		this.calls.push({ method: "abort" });
	}

	async abortAndPrompt(message: string): Promise<void> {
		this.calls.push({ method: "abortAndPrompt", args: message });
	}
}

async function tick(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("RpcControlStateMachine", () => {
	test("serializes operator input FIFO", async () => {
		const backend = new FakeBackend();
		backend.deferPrompt = true;
		const control = new RpcControlStateMachine({ backend });
		control.setState("attached_idle");

		control.submitText("one");
		control.submitText("two");
		await tick();
		expect(backend.calls.map(call => call.method)).toEqual(["prompt"]);
		backend.resolvePrompt();
		backend.deferPrompt = false;
		await tick();
		await tick();
		expect(backend.calls.map(call => call.method)).toEqual(["prompt", "prompt"]);
		expect(backend.calls.map(call => call.args)).toEqual(["one", "two"]);
	});

	test("routes idle text to prompt and active-turn text to steer", async () => {
		const backend = new FakeBackend();
		const control = new RpcControlStateMachine({ backend });
		control.setState("attached_idle");
		await control.submitText("new turn");
		control.handleEvent({ type: "turn_start", turnId: "turn-1" });
		await control.submitText("interrupt");
		await tick();
		expect(backend.calls.map(call => [call.method, call.args])).toEqual([
			["prompt", "new turn"],
			["steer", "interrupt"],
		]);
	});

	test("abort_and_prompt stays pending until new-turn proof and queues follow-on text", async () => {
		const backend = new FakeBackend();
		backend.state = { connected: true, socketPath: "/tmp/gjc.sock", session: { status: "active", turnId: "old" } };
		const control = new RpcControlStateMachine({ backend });
		control.setState("attached_turn_active");
		await control.abortAndPrompt("replacement");
		await tick();
		expect(control.state).toBe("control_pending_abort_and_prompt");
		control.submitText("follow on");
		await tick();
		expect(backend.calls.map(call => call.method)).not.toContain("steer");
		control.handleEvent({ type: "turn_start", turnId: "new" });
		await tick();
		expect(backend.calls.map(call => [call.method, call.args])).toContainEqual(["steer", "follow on"]);
	});

	test("abort transitions only after command response plus idle confirmation", async () => {
		const backend = new FakeBackend();
		backend.state = { connected: true, socketPath: "/tmp/gjc.sock", session: { status: "idle" } };
		const control = new RpcControlStateMachine({ backend });
		control.setState("attached_turn_active");
		await control.abort();
		await tick();
		expect(backend.calls.map(call => call.method)).toEqual(["abort", "getState"]);
		expect(control.state).toBe("attached_idle");
	});

	test("abort holds follow-on text until idle proof", async () => {
		const backend = new FakeBackend();
		backend.state = { connected: true, socketPath: "/tmp/gjc.sock", session: { status: "active", turnId: "old" } };
		const control = new RpcControlStateMachine({ backend });
		control.setState("attached_turn_active");
		await control.abort();
		control.submitText("do not steer yet");
		await tick();
		expect(backend.calls.map(call => [call.method, call.args])).not.toContainEqual(["steer", "do not steer yet"]);
		backend.state = { connected: true, socketPath: "/tmp/gjc.sock", session: { status: "idle" } };
		await control.refreshFromBackend();
		await tick();
		expect(backend.calls.map(call => [call.method, call.args])).toContainEqual(["prompt", "do not steer yet"]);
	});

	test("command timeout transitions to reconnecting and preserves queued input", async () => {
		const backend = new FakeBackend();
		backend.deferPrompt = true;
		const clock = new FakeClock();
		const signals: RpcControlSignal[] = [];
		const control = new RpcControlStateMachine({
			backend,
			clock,
			commandTimeoutMs: 1,
			onSignal: signal => signals.push(signal),
		});
		control.setState("attached_idle");
		void control.submitText("preserve me");
		await tick();
		clock.fireAll();
		await tick();
		expect(control.state).toBe("reconnecting");
		expect(control.queuedCount).toBe(1);
		expect(signals).toContainEqual({ kind: "reconnect_required", reason: "timeout", queuedInputs: 1 });
	});

	test("controller steal is visible reconnect/resync without dropping queued input", async () => {
		const backend = new FakeBackend();
		backend.deferPrompt = true;
		const signals: RpcControlSignal[] = [];
		const control = new RpcControlStateMachine({ backend, onSignal: signal => signals.push(signal) });
		control.setState("attached_idle");
		void control.submitText("in flight");
		await tick();
		control.controllerStolen();
		expect(control.state).toBe("reconnecting");
		expect(control.queuedCount).toBe(1);
		expect(signals).toContainEqual({ kind: "reconnect_required", reason: "controller_stolen", queuedInputs: 0 });
	});
});
