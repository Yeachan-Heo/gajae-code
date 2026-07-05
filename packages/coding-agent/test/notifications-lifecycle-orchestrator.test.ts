import { describe, expect, it } from "bun:test";

import type {
	SessionCloseFrame,
	SessionCreateFrame,
	SessionResumeFrame,
} from "@gajae-code/coding-agent/notifications/index";
import {
	type AuditEvent,
	classifyDuplicate,
	handleLifecycleRequest,
	type LedgerDoc,
	type LedgerEntry,
	type LedgerStore,
	type OrchestratorDeps,
	requestHash,
	summarizeTarget,
} from "@gajae-code/coding-agent/notifications/lifecycle-orchestrator";

const PAIRED = "42";

function memStore(initial?: LedgerDoc): LedgerStore & { doc: LedgerDoc } {
	const state = { doc: initial ?? { version: 1 as const, entries: {} } };
	return {
		doc: state.doc,
		read: async () => state.doc,
		write: async (d: LedgerDoc) => {
			state.doc = d;
		},
		get [Symbol.toStringTag]() {
			return "memStore";
		},
	} as unknown as LedgerStore & { doc: LedgerDoc };
}

function deps(overrides: Partial<OrchestratorDeps> = {}): {
	deps: OrchestratorDeps;
	audit: AuditEvent[];
	store: LedgerStore;
} {
	const audit: AuditEvent[] = [];
	const store = overrides.store ?? memStore();
	let n = 0;
	const base: OrchestratorDeps = {
		pairedChatId: PAIRED,
		now: () => 1_000,
		store,
		audit: e => {
			audit.push(e);
		},
		allowCreate: () => true,
		writeStartupPrompt: async () => "prompt-ref",
		spawnCreate: async (_f, ids) => ({
			sessionId: ids.intendedSessionId,
			tmuxSession: `gjc-${ids.intendedSessionId}`,
			sessionStateFile: "/state.jsonl",
			endpointUrl: "ws://127.0.0.1:5000",
			topicThreadId: "99",
		}),
		closeSession: async () => ({ processGone: true }),
		resumeSession: async () => ({
			sessionId: "sess-x",
			tmuxSession: "gjc-sess-x",
			endpointUrl: "ws://127.0.0.1:5001",
			topicThreadId: "99",
			mode: "reattached",
		}),
		newLifecycleRequestId: () => `lc-${++n}`,
		newSessionId: () => `sess-${++n}`,
		...overrides,
	};
	return { deps: base, audit, store };
}

function createFrame(over: Partial<SessionCreateFrame> = {}): SessionCreateFrame {
	return {
		type: "session_create",
		requestId: "lc_1",
		lifecycleRequestId: "lc_1",
		intendedSessionId: "sess_pre_1",
		updateId: 100,
		chatId: PAIRED,
		token: "control-token",
		target: { kind: "existing_path", path: "/repo" },
		...over,
	};
}

describe("lifecycle orchestrator", () => {
	it("rejects non-paired chats before any side effect", async () => {
		const { deps: d, audit } = deps();
		let spawned = false;
		const out = await handleLifecycleRequest(createFrame({ chatId: "999" }), {
			...d,
			spawnCreate: async () => {
				spawned = true;
				throw new Error("must not spawn");
			},
		});
		expect(out.status).toBe("error");
		if (out.status === "error") expect(out.reason).toBe("unauthorized");
		expect(spawned).toBe(false);
		expect(audit.at(-1)?.event).toBe("rejected");
	});

	it("creates a session and records success", async () => {
		const { deps: d, audit, store } = deps();
		const out = await handleLifecycleRequest(createFrame(), d);
		expect(out.status).toBe("ok");
		const entry = (await store.read()).entries[`${PAIRED}:100`];
		expect(entry?.state).toBe("success");
		expect(entry?.sessionId).toBe("sess_pre_1");
		expect(audit.map(a => a.event)).toEqual(["accepted", "spawn_started", "success"]);
	});

	it("never logs the raw control token in audit", async () => {
		const { deps: d, audit } = deps();
		await handleLifecycleRequest(createFrame(), d);
		const blob = JSON.stringify(audit);
		expect(blob).not.toContain("control-token");
	});

	it("re-acks a duplicate update id with the same body and does not respawn", async () => {
		const { deps: d, store } = deps();
		await handleLifecycleRequest(createFrame(), d);
		let secondSpawn = false;
		const out = await handleLifecycleRequest(createFrame(), {
			...d,
			store,
			spawnCreate: async () => {
				secondSpawn = true;
				throw new Error("must not respawn");
			},
		});
		expect(out.status).toBe("ok");
		expect(secondSpawn).toBe(false);
	});

	it("rejects a duplicate update id reused with a different body", async () => {
		const { deps: d, store } = deps();
		await handleLifecycleRequest(createFrame(), d);
		const out = await handleLifecycleRequest(createFrame({ target: { kind: "plain_dir", path: "/other" } }), {
			...d,
			store,
		});
		expect(out.status).toBe("error");
		if (out.status === "error") expect(out.reason).toBe("duplicate_conflict");
	});

	it("enforces the per-chat create rate limit", async () => {
		const { deps: d } = deps({ allowCreate: () => false });
		const out = await handleLifecycleRequest(createFrame(), d);
		expect(out.status).toBe("error");
		if (out.status === "error") expect(out.reason).toBe("rate_limited");
	});

	it("marks terminal_uncertain (never respawn) when a spawn effect throws", async () => {
		const { deps: d, store } = deps({
			spawnCreate: async () => {
				throw new Error("boom");
			},
		});
		const out = await handleLifecycleRequest(createFrame(), d);
		expect(out.status).toBe("error");
		if (out.status === "error") expect(out.reason).toBe("terminal_uncertain");
		expect((await store.read()).entries[`${PAIRED}:100`]?.state).toBe("terminal_uncertain");
	});

	it("fails closed on an ambiguous resume", async () => {
		const { deps: d } = deps({
			resumeSession: async () => ({ ambiguous: [{ sessionId: "a" }, { sessionId: "b" }] }),
		});
		const frame: SessionResumeFrame = {
			type: "session_resume",
			requestId: "lc_r",
			updateId: 200,
			chatId: PAIRED,
			token: "control-token",
			target: { sessionIdOrPrefix: "se" },
		};
		const out = await handleLifecycleRequest(frame, d);
		expect(out.status).toBe("error");
		if (out.status === "error") {
			expect(out.reason).toBe("ambiguous_target");
			expect(out.candidates).toHaveLength(2);
		}
	});

	it("fails closed with not_found when resume resolves no saved session", async () => {
		const { deps: d, audit } = deps({
			resumeSession: async () => ({ notFound: true }),
		});
		const frame: SessionResumeFrame = {
			type: "session_resume",
			requestId: "lc_r2",
			updateId: 201,
			chatId: PAIRED,
			token: "control-token",
			target: { sessionIdOrPrefix: "nope" },
		};
		const out = await handleLifecycleRequest(frame, d);
		expect(out.status).toBe("error");
		if (out.status === "error") expect(out.reason).toBe("not_found");
		expect(audit.some(e => e.event === "failure" && e.reason === "not_found")).toBe(true);
	});

	it("rejects session_close without force before any close side effect", async () => {
		const { deps: d, audit, store } = deps();
		let closed = false;
		const frame: SessionCloseFrame = {
			type: "session_close",
			requestId: "lc_c_no_force",
			updateId: 299,
			chatId: PAIRED,
			token: "control-token",
			target: { sessionId: "sess-1", tmuxSession: "gjc-1" },
		};
		const out = await handleLifecycleRequest(frame, {
			...d,
			closeSession: async () => {
				closed = true;
				throw new Error("must not close");
			},
		});
		expect(out.status).toBe("error");
		if (out.status === "error") {
			expect(out.reason).toBe("invalid_target");
			expect(out.message).toBe("session_close requires force=true; graceful close is not supported");
		}
		expect(closed).toBe(false);
		expect((await store.read()).entries[`${PAIRED}:299`]).toBeUndefined();
		expect(audit.at(-1)).toMatchObject({ event: "rejected", reason: "invalid_target" });
	});

	it("rejects session_close with force=false before any close side effect", async () => {
		const { deps: d, audit, store } = deps();
		let closed = false;
		const frame: SessionCloseFrame = {
			type: "session_close",
			requestId: "lc_c_force_false",
			updateId: 301,
			chatId: PAIRED,
			token: "control-token",
			target: { sessionId: "sess-1", tmuxSession: "gjc-1" },
			force: false,
		};
		const out = await handleLifecycleRequest(frame, {
			...d,
			closeSession: async () => {
				closed = true;
				throw new Error("must not close");
			},
		});
		expect(out.status).toBe("error");
		if (out.status === "error") {
			expect(out.reason).toBe("invalid_target");
			expect(out.message).toBe("session_close requires force=true; graceful close is not supported");
		}
		expect(closed).toBe(false);
		expect((await store.read()).entries[`${PAIRED}:301`]).toBeUndefined();
		expect(audit.at(-1)).toMatchObject({ event: "rejected", reason: "invalid_target" });
	});

	it("closes a session when force is true", async () => {
		let closeCalls = 0;
		const { deps: d } = deps({
			closeSession: async () => {
				closeCalls++;
				return { processGone: true };
			},
		});
		const frame: SessionCloseFrame = {
			type: "session_close",
			requestId: "lc_c",
			updateId: 300,
			chatId: PAIRED,
			token: "control-token",
			target: { sessionId: "sess-1", tmuxSession: "gjc-1" },
			force: true,
		};
		const out = await handleLifecycleRequest(frame, d);
		expect(out.status).toBe("ok");
		expect(closeCalls).toBe(1);
	});

	it("records close failures as close_refused diagnostics, not spawn failures", async () => {
		const {
			deps: d,
			audit,
			store,
		} = deps({
			closeSession: async () => {
				throw new Error("tmux session mismatch");
			},
		});
		const frame: SessionCloseFrame = {
			type: "session_close",
			requestId: "lc_c_refused",
			updateId: 302,
			chatId: PAIRED,
			token: "control-token",
			target: { sessionId: "sess-1", tmuxSession: "gjc-1" },
			force: true,
		};
		const out = await handleLifecycleRequest(frame, d);
		expect(out.status).toBe("error");
		if (out.status === "error") {
			expect(out.reason).toBe("terminal_uncertain");
			expect(out.message).toContain("session_close effect failed");
		}
		expect((await store.read()).entries[`${PAIRED}:302`]?.reason).toBe("close_refused");
		expect(audit.at(-1)).toMatchObject({ event: "terminal_uncertain", reason: "close_refused" });
	});

	it("classifyDuplicate / requestHash / summarizeTarget are stable", () => {
		const a = requestHash(createFrame());
		const b = requestHash(createFrame());
		expect(a).toBe(b);
		expect(requestHash(createFrame({ target: { kind: "plain_dir", path: "/x" } }))).not.toBe(a);
		expect(summarizeTarget(createFrame())).toEqual({ kind: "existing_path", path: "/repo" });
		const entry: LedgerEntry = {
			requestHash: a,
			state: "success",
			requestId: "lc_1",
			verb: "session_create",
			createdAt: 0,
			updatedAt: 0,
			targetSummary: {},
		};
		expect(classifyDuplicate(undefined, a).kind).toBe("new");
		expect(classifyDuplicate(entry, a).kind).toBe("reack_success");
		expect(classifyDuplicate(entry, "different").kind).toBe("conflict");
	});
});
