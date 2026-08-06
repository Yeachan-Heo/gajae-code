import { expect, test } from "bun:test";
import { ConnectionState } from "../../router/connection-state";

test("authorize: any request before initialize is Not initialized", () => {
	const s = new ConnectionState();
	const r = s.authorize("thread/start");
	expect(r.ok).toBe(false);
	if (r.ok) throw new Error("unreachable");
	expect(r.key).toBe("notInitialized");
});

test("authorize: the first initialize is allowed; a second is Already initialized", () => {
	const s = new ConnectionState();
	expect(s.authorize("initialize").ok).toBe(true);
	s.beginInitialize(undefined);
	s.completeInitialize();
	const r = s.authorize("initialize");
	expect(r.ok).toBe(false);
	if (r.ok) throw new Error("unreachable");
	expect(r.key).toBe("alreadyInitialized");
});

test("authorize: a request between initialize and initialized is still Not initialized", () => {
	const s = new ConnectionState();
	s.beginInitialize(undefined);
	// handshake begun but not completed
	expect(s.authorize("thread/start")).toEqual({ ok: false, key: "notInitialized" });
});

test("beginInitialize: records capabilities, including experimentalApi and exact-match opt-outs", () => {
	const s = new ConnectionState();
	s.beginInitialize({
		clientInfo: { name: "test-client", version: "0.0.1" },
		capabilities: {
			experimentalApi: true,
			optOutNotificationMethods: ["thread/started", "item/agentMessage/delta", "thread/started"],
		},
	});
	s.completeInitialize();
	expect(s.capabilities?.experimentalApi).toBe(true);
	expect(s.capabilities?.clientInfo?.name).toBe("test-client");
	// dedup + exact match
	expect(s.capabilities?.optOutNotificationMethods.size).toBe(2);
	expect(s.optsOutOf("thread/started")).toBe(true);
	expect(s.optsOutOf("item/agentMessage/delta")).toBe(true);
	// prefix does NOT match (no wildcards)
	expect(s.optsOutOf("thread/started/something")).toBe(false);
	expect(s.optsOutOf("THREAD/STARTED")).toBe(false);
});

test("optOut: unknown method names in the array are accepted and ignored (no validation error)", () => {
	const s = new ConnectionState();
	expect(() =>
		s.beginInitialize({
			capabilities: { optOutNotificationMethods: ["bogus/method", "", 123 as unknown as string] },
		}),
	).not.toThrow();
	// empty/non-string entries are filtered out
	expect(s.capabilities?.optOutNotificationMethods.has("bogus/method")).toBe(true);
	expect(s.capabilities?.optOutNotificationMethods.size).toBe(1);
});

test("completeInitialize: no-op unless a handshake was begun", () => {
	const s = new ConnectionState();
	expect(s.completeInitialize()).toBe(false);
	expect(s.initialized).toBe(false);
});

test("a second connection instance is independent (no cross-connection state leak)", () => {
	const a = new ConnectionState();
	const b = new ConnectionState();
	a.beginInitialize(undefined);
	a.completeInitialize();
	expect(a.initialized).toBe(true);
	expect(b.initialized).toBe(false);
	expect(b.authorize("thread/start")).toEqual({ ok: false, key: "notInitialized" });
});
