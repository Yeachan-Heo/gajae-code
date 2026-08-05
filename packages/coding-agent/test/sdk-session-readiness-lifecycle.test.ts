import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type SdkFrame, SESSION_PREPARED_EVENT, type SessionActivationGate, SessionSdkHost } from "../src/sdk/host";

type Emitted = { name?: string; sessionId?: string; generation?: number };

async function withHost(
	options: {
		readiness?: "immediate" | "deferred";
		activationGate?: SessionActivationGate;
		control?: (connectionId: string, frame: SdkFrame) => Record<string, unknown> | undefined;
	},
	run: (input: {
		host: SessionSdkHost;
		events: () => Emitted[];
		sent: Record<string, unknown>[];
		frame: (value: SdkFrame) => Promise<void>;
	}) => Promise<void>,
): Promise<void> {
	const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-readiness-"));
	let host: SessionSdkHost | undefined;
	try {
		const sent: Record<string, unknown>[] = [];
		let inbound: ((connectionId: string, frame: SdkFrame) => void) | undefined;
		host = new SessionSdkHost({
			sessionId: "session-1",
			stateRoot,
			token: "not-persisted",
			sendFrame: (_connectionId, frame) => {
				sent.push(frame as Record<string, unknown>);
			},
			onFrame: handler => {
				inbound = handler;
				return () => {
					inbound = undefined;
				};
			},
			...(options.readiness ? { readiness: options.readiness } : {}),
			...(options.activationGate ? { activationGate: options.activationGate } : {}),
			...(options.control ? { control: options.control } : {}),
		});
		await host.start();
		const activeHost = host;
		const events = (): Emitted[] =>
			activeHost.events.replay(0).events.map(event => ({
				name: typeof event.name === "string" ? event.name : undefined,
				sessionId: typeof event.sessionId === "string" ? event.sessionId : undefined,
				generation: typeof event.generation === "number" ? event.generation : undefined,
			}));
		await run({
			host,
			events,
			sent,
			frame: async value => {
				inbound?.("connection-1", value);
				// `#onFrame` is fire-and-forget; yield until its answer is observable.
				for (let attempt = 0; attempt < 50 && sent.length === 0; attempt++) await Bun.sleep(1);
			},
		});
	} finally {
		await host?.stop();
		await fs.rm(stateRoot, { recursive: true, force: true });
	}
}

describe("prepared session readiness lifecycle", () => {
	test("an ordinary session publishes readiness immediately and reports no prepared signal", async () => {
		await withHost({}, async ({ host, events }) => {
			expect(events().map(event => event.name)).toEqual(["session_ready"]);
			expect(host.ready).toBe(true);
			expect(host.prepared).toBe(false);
		});
	});

	test("a prepared session publishes discoverable authority but no readiness", async () => {
		await withHost({ readiness: "deferred", activationGate: () => false }, async ({ host, events }) => {
			const published = events();
			expect(published.map(event => event.name)).toEqual([SESSION_PREPARED_EVENT]);
			expect(published[0]).toMatchObject({ sessionId: "session-1", generation: host.generation });
			expect(published.some(event => event.name === "session_ready")).toBe(false);
			expect(host.prepared).toBe(true);
			expect(host.ready).toBe(false);
		});
	});

	test("a prepared session refuses control requests until it is activated", async () => {
		// Deferred readiness withheld only `session_ready`; the control dispatcher
		// stayed reachable, so activation was optional for input admission.
		let dispatched = 0;
		await withHost(
			{
				readiness: "deferred",
				activationGate: () => false,
				control: () => {
					dispatched++;
					return { id: "c1", ok: true };
				},
			},
			async ({ host, sent, frame }) => {
				expect(host.prepared).toBe(true);
				await frame({ type: "control_request", id: "c1", op: "prompt" } as unknown as SdkFrame);

				expect(dispatched).toBe(0);
				expect(sent).toHaveLength(1);
				expect(sent[0]).toMatchObject({
					type: "control_response",
					id: "c1",
					ok: false,
					error: { code: "not_activated" },
				});
			},
		);
	});

	test("an activated session admits control requests again", async () => {
		let dispatched = 0;
		await withHost(
			{
				readiness: "deferred",
				activationGate: () => true,
				control: () => {
					dispatched++;
					return { id: "c1", ok: true };
				},
			},
			async ({ host, sent, frame }) => {
				expect(await host.activate(host.generation)).toBe("activated");
				expect(host.prepared).toBe(false);
				await frame({ type: "control_request", id: "c1", op: "prompt" } as unknown as SdkFrame);

				expect(dispatched).toBe(1);
				expect(sent.some(value => (value as { ok?: boolean }).ok === false)).toBe(false);
			},
		);
	});

	test("activation before a binding is refused with no readiness publication", async () => {
		let asked = 0;
		await withHost(
			{
				readiness: "deferred",
				activationGate: () => {
					asked++;
					return false;
				},
			},
			async ({ host, events }) => {
				expect(await host.activate(host.generation)).toBe("not_authorized");
				expect(asked).toBe(1);
				expect(events().some(event => event.name === "session_ready")).toBe(false);
				expect(host.ready).toBe(false);
			},
		);
	});

	test("an unreadable activation authority is reported as unavailable, never as an authorization", async () => {
		await withHost(
			{
				readiness: "deferred",
				activationGate: () => {
					throw new Error("mapping store unreadable");
				},
			},
			async ({ host, events }) => {
				expect(await host.activate()).toBe("authority_unavailable");
				expect(events().some(event => event.name === "session_ready")).toBe(false);
			},
		);
	});

	test("activation publishes readiness once and an exact retry answers already", async () => {
		let bound = false;
		await withHost({ readiness: "deferred", activationGate: () => bound }, async ({ host, events }) => {
			bound = true;
			expect(await host.activate(host.generation)).toBe("activated");
			expect(await host.activate(host.generation)).toBe("already");
			const ready = events().filter(event => event.name === "session_ready");
			expect(ready).toHaveLength(1);
			expect(ready[0]).toMatchObject({ sessionId: "session-1", generation: host.generation });
			expect(host.ready).toBe(true);
		});
	});

	test("a rolled generation is refused without publishing readiness", async () => {
		await withHost({ readiness: "deferred", activationGate: () => true }, async ({ host, events }) => {
			expect(await host.activate(host.generation + 1)).toBe("generation_changed");
			expect(events().some(event => event.name === "session_ready")).toBe(false);
		});
	});

	test("concurrent activations publish exactly one readiness signal", async () => {
		await withHost({ readiness: "deferred", activationGate: async () => true }, async ({ host, events }) => {
			const outcomes = await Promise.all([host.activate(), host.activate(), host.activate()]);
			expect(outcomes.filter(outcome => outcome === "activated")).toHaveLength(1);
			expect(outcomes.filter(outcome => outcome === "already")).toHaveLength(2);
			expect(events().filter(event => event.name === "session_ready")).toHaveLength(1);
		});
	});

	test("the session_activate frame answers the exact session and refuses a foreign one", async () => {
		await withHost({ readiness: "deferred", activationGate: () => true }, async ({ host, sent, frame }) => {
			await frame({ type: "session_activate", id: "activate-1", sessionId: "other-session" });
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({
				type: "session_activate_result",
				id: "activate-1",
				ok: false,
				status: "session_mismatch",
				sessionId: "session-1",
			});
			expect(host.ready).toBe(false);

			sent.length = 0;
			await frame({
				type: "session_activate",
				id: "activate-2",
				sessionId: "session-1",
				endpointGeneration: host.generation,
			});
			expect(sent[0]).toMatchObject({
				type: "session_activate_result",
				id: "activate-2",
				ok: true,
				status: "activated",
				sessionId: "session-1",
				generation: host.generation,
			});
		});
	});

	test("the session_activate frame reports an unauthorized activation as not_bound authority", async () => {
		await withHost({ readiness: "deferred", activationGate: () => false }, async ({ host, sent, frame }) => {
			await frame({
				type: "session_activate",
				id: "activate-3",
				sessionId: "session-1",
				endpointGeneration: host.generation,
			});
			expect(sent[0]).toMatchObject({
				type: "session_activate_result",
				ok: false,
				status: "not_authorized",
				error: { code: "not_authorized" },
			});
		});
	});
});
