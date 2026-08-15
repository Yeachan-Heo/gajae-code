import { describe, expect, test } from "bun:test";
import {
	INBOUND_REACTION_TOMBSTONE_WINDOW,
	InboundReactionSequencer,
	inboundReactionRetractPayload,
	inboundReactionSetPayload,
} from "../src/sdk/bus/inbound-reaction-ordering";

/** Deferred gate: records the transition and settles only when released. */
interface GatedCall {
	name: string;
	release: () => void;
}

function gatedEffect(name: string): { effect: () => Promise<void>; call: GatedCall } {
	let release!: () => void;
	const settled = new Promise<void>(resolve => {
		release = resolve;
	});
	return {
		effect: async () => {
			await settled;
		},
		call: { name, release },
	};
}

describe("inbound reaction transition ordering", () => {
	test("concurrent accepted then consumed serialize and the terminal state stays final", async () => {
		const sequencer = new InboundReactionSequencer();
		const order: string[] = [];
		const accepted = gatedEffect("queued");
		const consumed = gatedEffect("consumed");

		// Router-style concurrent dispatch: neither callback awaits the other.
		const acceptedPromise = sequencer.apply(701, {
			terminal: false,
			effect: async () => {
				order.push("queued");
				await accepted.effect();
			},
		});
		const consumedPromise = sequencer.apply(701, {
			terminal: true,
			effect: async () => {
				order.push("consumed");
				await consumed.effect();
			},
		});

		// Only the first (accepted) transition may run; consumed is queued behind it.
		await Bun.sleep(20);
		expect(order).toEqual(["queued"]);
		expect(sequencer.isTerminal(701)).toBe(false);

		accepted.call.release();
		await Bun.sleep(20);
		expect(order).toEqual(["queued", "consumed"]);
		consumed.call.release();
		await Promise.all([acceptedPromise, consumedPromise]);
		expect(sequencer.isTerminal(701)).toBe(true);
	});

	test("a late accepted ack after a terminal retraction is a no-op", async () => {
		const sequencer = new InboundReactionSequencer();
		const effects: string[] = [];

		await sequencer.apply(702, {
			terminal: true,
			effect: async () => {
				effects.push("retract");
			},
		});
		expect(sequencer.isTerminal(702)).toBe(true);

		// A stale accepted ack arriving afterwards must not run its effect.
		await sequencer.apply(702, {
			terminal: false,
			effect: async () => {
				effects.push("queued");
			},
		});
		expect(effects).toEqual(["retract"]);
	});

	test("a failed terminal transition does not close the update", async () => {
		const sequencer = new InboundReactionSequencer();
		const effects: string[] = [];
		await sequencer
			.apply(703, {
				terminal: true,
				effect: async () => {
					effects.push("failing-retract");
					throw new Error("bot api unavailable");
				},
			})
			.catch(() => undefined);
		expect(sequencer.isTerminal(703)).toBe(false);
		// The update remains correctable: a later transition still runs.
		await sequencer.apply(703, {
			terminal: true,
			effect: async () => {
				effects.push("retry-retract");
			},
		});
		expect(effects).toEqual(["failing-retract", "retry-retract"]);
		expect(sequencer.isTerminal(703)).toBe(true);
	});

	test("distinct update ids do not serialize against each other", async () => {
		const sequencer = new InboundReactionSequencer();
		const order: string[] = [];
		const first = gatedEffect("first");

		const firstPromise = sequencer.apply(801, {
			terminal: false,
			effect: async () => {
				order.push("first");
				await first.effect();
			},
		});
		await Bun.sleep(20);
		// A different update id runs while 801 is still gated.
		await sequencer.apply(802, {
			terminal: true,
			effect: async () => {
				order.push("second");
			},
		});
		expect(order).toEqual(["first", "second"]);
		first.call.release();
		await firstPromise;
	});

	test("settled chains are deleted so per-update state stays bounded", async () => {
		const sequencer = new InboundReactionSequencer();
		const effects: string[] = [];
		for (let updateId = 1; updateId <= 50; updateId++) {
			await sequencer.apply(updateId, {
				terminal: true,
				effect: async () => {
					effects.push(`retract-${updateId}`);
				},
			});
		}
		expect(effects.length).toBe(50);
		// After every transition settled there is no in-flight work left, so no
		// per-update chain may be retained. (Tombstones are covered separately.)
		expect(sequencer.debugChainCount()).toBe(0);
	});

	test("terminal tombstones evict only updates far outside the recent window", async () => {
		const sequencer = new InboundReactionSequencer();
		const near = 1_000;
		const recent = 1_200;
		// Two terminal updates inside one retention window of each other.
		await sequencer.apply(near, { terminal: true, effect: async () => undefined });
		await sequencer.apply(recent, { terminal: true, effect: async () => undefined });
		expect(sequencer.isTerminal(near)).toBe(true);
		expect(sequencer.isTerminal(recent)).toBe(true);

		// A stale accepted for a still-retained terminal update is still ignored.
		const staleEffects: string[] = [];
		await sequencer.apply(recent, {
			terminal: false,
			effect: async () => {
				staleEffects.push("queued");
			},
		});
		expect(staleEffects).toEqual([]);

		// A much newer terminal update evicts only tombstones outside the window;
		// near-term ones survive so a late accepted cannot overwrite them.
		const newest = near + INBOUND_REACTION_TOMBSTONE_WINDOW;
		await sequencer.apply(newest, { terminal: true, effect: async () => undefined });
		expect(sequencer.isTerminal(near)).toBe(false);
		expect(sequencer.isTerminal(recent)).toBe(true);
		expect(sequencer.isTerminal(newest)).toBe(true);
		// Bounded: total retained tombstones never exceed the window.
		expect(sequencer.debugTombstoneCount()).toBeLessThanOrEqual(INBOUND_REACTION_TOMBSTONE_WINDOW);
	});

	test("retained tombstone state stays bounded across many updates", async () => {
		const sequencer = new InboundReactionSequencer();
		for (let updateId = 1; updateId <= INBOUND_REACTION_TOMBSTONE_WINDOW * 3; updateId++) {
			await sequencer.apply(updateId, { terminal: true, effect: async () => undefined });
		}
		expect(sequencer.debugTombstoneCount()).toBeLessThanOrEqual(INBOUND_REACTION_TOMBSTONE_WINDOW);
		expect(sequencer.debugChainCount()).toBe(0);
	});

	test("set payload maps an emoji marker to the Bot API reaction array", () => {
		expect(inboundReactionSetPayload("42", 5001, "👀")).toEqual({
			chat_id: "42",
			message_id: 5001,
			reaction: [{ type: "emoji", emoji: "👀" }],
		});
		expect(inboundReactionSetPayload("42", 5002, "✅")).toEqual({
			chat_id: "42",
			message_id: 5002,
			reaction: [{ type: "emoji", emoji: "✅" }],
		});
	});

	test("retract payload is the empty reaction array, never an empty emoji string", () => {
		expect(inboundReactionRetractPayload("42", 5003)).toEqual({
			chat_id: "42",
			message_id: 5003,
			reaction: [],
		});
		const serialized = JSON.stringify(inboundReactionRetractPayload("42", 5003));
		expect(serialized).toContain('"reaction":[]');
		expect(serialized).not.toContain('{"type":"emoji","emoji":""}');
	});
});
