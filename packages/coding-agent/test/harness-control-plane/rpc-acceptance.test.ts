import { describe, expect, it } from "bun:test";
import {
	type HarnessRpc,
	type RpcStateSnapshot,
	singleFlightAccept,
} from "../../src/harness-control-plane/rpc-adapter";

/** Programmable in-memory RPC for acceptance-logic tests (no real gjc subprocess). */
class FakeRpc implements HarnessRpc {
	cursor = 0;
	state: RpcStateSnapshot = { isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 };
	ack = true;
	agentStarts: number[] = [];
	onSendPrompt?: (rpc: FakeRpc) => void;

	async getState(): Promise<RpcStateSnapshot> {
		return this.state;
	}
	eventCursor(): number {
		return this.cursor;
	}
	async sendPrompt(_prompt: string): Promise<{ commandId: string; ack: boolean }> {
		this.onSendPrompt?.(this);
		return { commandId: "cmd-1", ack: this.ack };
	}
	/** Simulate the harness emitting an agent_start (advances the event cursor). */
	emitAgentStart(): void {
		this.cursor += 1;
		this.agentStarts.push(this.cursor);
	}
	emitOtherEvent(): void {
		this.cursor += 1;
	}
	async waitForAgentStart(afterCursor: number, _timeoutMs: number): Promise<{ cursor: number } | null> {
		const found = this.agentStarts.find(c => c > afterCursor);
		return found === undefined ? null : { cursor: found };
	}
	async close(): Promise<void> {}
}

describe("singleFlightAccept", () => {
	it("accepts only when the next agent_start follows the ack (idle pre-state)", async () => {
		const rpc = new FakeRpc();
		rpc.onSendPrompt = r => r.emitAgentStart();
		const res = await singleFlightAccept(rpc, "do the thing", 1000);
		expect(res.accepted).toBe(true);
		expect(res.reason).toBe("protocol-ack-single-flight");
		expect(res.agentStartCursor).toBe(res.preSubmitCursor + 1);
	});

	it("rejects ack-only with no agent_start (the tmux 'visible != submitted' trap)", async () => {
		const rpc = new FakeRpc();
		rpc.ack = true; // acked but the harness never starts
		const res = await singleFlightAccept(rpc, "p", 1000);
		expect(res.accepted).toBe(false);
		expect(res.reason).toBe("no-agent-start-within-timeout");
	});

	it("rejects when the command is not acked", async () => {
		const rpc = new FakeRpc();
		rpc.ack = false;
		rpc.onSendPrompt = r => r.emitAgentStart();
		const res = await singleFlightAccept(rpc, "p", 1000);
		expect(res.accepted).toBe(false);
		expect(res.reason).toBe("no-ack");
	});

	it("rejects a non-idle (streaming) pre-state", async () => {
		const rpc = new FakeRpc();
		rpc.state = { isStreaming: true, steeringQueueDepth: 0, followupQueueDepth: 0 };
		rpc.onSendPrompt = r => r.emitAgentStart();
		const res = await singleFlightAccept(rpc, "p", 1000);
		expect(res.accepted).toBe(false);
		expect(res.reason).toBe("pre-state-not-idle");
	});

	it("rejects when steering/follow-up queues are non-empty", async () => {
		const rpc = new FakeRpc();
		rpc.state = { isStreaming: false, steeringQueueDepth: 2, followupQueueDepth: 0 };
		const res = await singleFlightAccept(rpc, "p", 1000);
		expect(res.accepted).toBe(false);
		expect(res.reason).toBe("pre-state-not-idle");
	});

	it("does NOT count a stale agent_start that preceded the submit cursor", async () => {
		const rpc = new FakeRpc();
		rpc.emitAgentStart(); // stale: happens before the prompt, cursor now 1
		rpc.ack = true; // prompt is acked but produces no NEW agent_start
		const res = await singleFlightAccept(rpc, "p", 1000);
		expect(res.accepted).toBe(false);
		expect(res.reason).toBe("no-agent-start-within-timeout");
		expect(res.preSubmitCursor).toBe(1);
	});

	it("ignores unrelated events and still requires a fresh agent_start", async () => {
		const rpc = new FakeRpc();
		rpc.onSendPrompt = r => {
			r.emitOtherEvent(); // message_update etc. — not acceptance
		};
		const res = await singleFlightAccept(rpc, "p", 1000);
		expect(res.accepted).toBe(false);
		expect(res.reason).toBe("no-agent-start-within-timeout");
	});
});
