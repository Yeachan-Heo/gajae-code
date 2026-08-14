import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";

import type { SessionCloseFrame, SessionCreateFrame, SessionResumeFrame } from "@gajae-code/coding-agent/sdk/bus/index";
import {
	type AuditEvent,
	auditRedactionRef,
	canonicalRequest,
	canonicalTarget,
	classifyDuplicate,
	handleLifecycleRequest,
	type LedgerDoc,
	type LedgerEntry,
	type LedgerStore,
	type OrchestratorDeps,
	requestHash,
	summarizeTarget,
} from "@gajae-code/coding-agent/sdk/bus/lifecycle-orchestrator";

const PAIRED = "42";

function memStore(initial?: LedgerDoc): LedgerStore {
	const state = { doc: initial ?? { version: 1 as const, entries: {} } };
	return {
		read: async () => state.doc,
		write: async (d: LedgerDoc) => {
			state.doc = d;
		},
	};
}

function deps(overrides: Partial<OrchestratorDeps> = {}): {
	deps: OrchestratorDeps;
	audit: AuditEvent[];
	store: LedgerStore;
} {
	const audit: AuditEvent[] = [];
	const store = overrides.store ?? memStore();
	const base: OrchestratorDeps = {
		pairedChatId: PAIRED,
		auditRedactionKey: new Uint8Array(32).fill(7),
		isPsmuxProvider: () => false,
		now: () => 1_000,
		store,
		audit: e => {
			audit.push(e);
		},
		allowCreate: () => true,
		writeStartupPrompt: async (_requestId, prompt) => prompt,
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
describe("canonical lifecycle correlation", () => {
	it("uses independent RFC4231 HMAC-SHA-256 bytes", () => {
		expect(crypto.createHmac("sha256", new Uint8Array(20).fill(0x0b)).update("Hi There").digest("hex")).toBe(
			"b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
		);
		expect(
			crypto
				.createHmac("sha256", Buffer.from("Jefe", "utf8"))
				.update("what do ya want for nothing?", "utf8")
				.digest("hex"),
		).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
	});

	it("uses exact ordered bytes, explicit optionals, and model preset in the request hash", () => {
		const frame = createFrame({
			target: { kind: "existing_path", path: 'C:\\repo\\"quoted"' },
			modelPreset: "codex-eco",
		});
		expect(canonicalTarget(frame)).toBe('{"kind":"existing_path","path":"C:\\\\repo\\\\\\"quoted\\""}');
		expect(canonicalRequest(frame)).toBe(
			'{"type":"session_create","target":{"kind":"existing_path","path":"C:\\\\repo\\\\\\"quoted\\""},"startupPromptRef":null,"modelPreset":"codex-eco","force":null}',
		);
		expect(requestHash(createFrame())).not.toBe(requestHash(frame));
	});

	it("rejects lone UTF-16 surrogates before audit, storage, or effects", async () => {
		let reads = 0;
		let audits = 0;
		const { deps: d } = deps({
			store: {
				read: async () => {
					reads++;
					return { version: 1, entries: {} };
				},
				write: async () => {},
			},
			audit: () => {
				audits++;
			},
		});
		const outcome = await handleLifecycleRequest(createFrame({ target: { kind: "plain_dir", path: "\ud800" } }), d);
		expect(outcome).toEqual({ status: "error", reason: "invalid_target", message: "invalid lifecycle target" });
		expect(reads).toBe(0);
		expect(audits).toBe(0);
	});

	it("matches independently generated audit-v2 canonical bytes, hashes, references, and serialized allowlist", async () => {
		const variants: Array<{
			name: string;
			frame: SessionCreateFrame | SessionCloseFrame | SessionResumeFrame;
			target: string;
			request: string;
			hash: string;
			targetRef: string;
			requestRef: string;
			targetKind: string;
			audit?: string;
			rawValues: string[];
		}> = [
			{
				name: "quoted existing_path",
				frame: createFrame({
					updateId: 100,
					chatId: "99",
					target: { kind: "existing_path", path: 'C:\\repo\\"quoted"' },
					modelPreset: "codex-eco",
				}),
				target: '{"kind":"existing_path","path":"C:\\\\repo\\\\\\"quoted\\""}',
				request:
					'{"type":"session_create","target":{"kind":"existing_path","path":"C:\\\\repo\\\\\\"quoted\\""},"startupPromptRef":null,"modelPreset":"codex-eco","force":null}',
				hash: "d281bec48aba2844bef9a3ff66102d0366210e44ea99af79907e2a77ec624b4c",
				targetRef: "a317cb142c695e865aa0b3e7b95ade856df1e8105875eda1f6315b768cb616a4",
				requestRef: "67b9413235920dec88874b45e77daa2010cab0d0d1df2ee1da5ba44f2330c1e4",
				targetKind: "existing_path",
				rawValues: ['C:\\repo\\"quoted"', "codex-eco", "control-token"],
				audit: '{"schemaVersion":2,"ts":"1970-01-01T00:00:01.000Z","chatRef":"f05b1a602d9038ea96b543dc8929a33d587f1f8b48af352460ffc0f81d178bdf","updateId":100,"requestRef":"67b9413235920dec88874b45e77daa2010cab0d0d1df2ee1da5ba44f2330c1e4","verb":"session_create","targetKind":"existing_path","targetRef":"a317cb142c695e865aa0b3e7b95ade856df1e8105875eda1f6315b768cb616a4","event":"rejected","reason":"unauthorized"}',
			},
			{
				name: "plain_dir non-ASCII",
				frame: createFrame({
					updateId: 101,
					chatId: "99",
					target: { kind: "plain_dir", path: "/新しい ディレクトリ" },
				}),
				target: '{"kind":"plain_dir","path":"/新しい ディレクトリ"}',
				request:
					'{"type":"session_create","target":{"kind":"plain_dir","path":"/新しい ディレクトリ"},"startupPromptRef":null,"modelPreset":null,"force":null}',
				hash: "a11eb7d921d0e036180013dacca73d56878a4edcb7352efa24da74cf44971e2a",
				targetRef: "0414dbe87dc9d86ff579bb1fd18832100dba0208adb0b2753c5195793483c0cc",
				requestRef: "78c3d37443ee49d596048dd9d3d0326d4e0d50499adfacc90627b6999f526508",
				targetKind: "plain_dir",
				rawValues: ["/新しい ディレクトリ", "control-token"],
				audit: '{"schemaVersion":2,"ts":"1970-01-01T00:00:01.000Z","chatRef":"f05b1a602d9038ea96b543dc8929a33d587f1f8b48af352460ffc0f81d178bdf","updateId":101,"requestRef":"78c3d37443ee49d596048dd9d3d0326d4e0d50499adfacc90627b6999f526508","verb":"session_create","targetKind":"plain_dir","targetRef":"0414dbe87dc9d86ff579bb1fd18832100dba0208adb0b2753c5195793483c0cc","event":"rejected","reason":"unauthorized"}',
			},
			{
				name: "worktree",
				frame: createFrame({
					updateId: 102,
					chatId: "99",
					target: { kind: "worktree", repo: "/repo", branch: "feat/x" },
				}),
				target: '{"kind":"worktree","repo":"/repo","branch":"feat/x"}',
				request:
					'{"type":"session_create","target":{"kind":"worktree","repo":"/repo","branch":"feat/x"},"startupPromptRef":null,"modelPreset":null,"force":null}',
				hash: "f06086b61a2e5f843af7e7b84f5906b06bb94406baea3a3bb544142b1382a2aa",
				targetRef: "ea1a203670e480216b15b72cebeaa3fc036e087a320f2d605ea4ad380e716e0b",
				requestRef: "b7d0e5624273f918b98020b421d818a92cdaf84c399c5992407699103a5c8293",
				targetKind: "worktree",
				rawValues: ["/repo", "feat/x", "control-token"],
			},
			{
				name: "close null optionals",
				frame: {
					type: "session_close",
					requestId: "close-null",
					updateId: 103,
					chatId: "99",
					token: "control-token",
					target: { sessionId: "sess-close" },
				},
				target: '{"kind":"session_close","sessionId":"sess-close","tmuxSession":null,"sessionStateFile":null}',
				request:
					'{"type":"session_close","target":{"kind":"session_close","sessionId":"sess-close","tmuxSession":null,"sessionStateFile":null},"startupPromptRef":null,"modelPreset":null,"force":false}',
				hash: "508eb3d45379ee6c992c5ba35c0665a4db4f88d9de4849639e8774cc4c115f64",
				targetRef: "37578b8e5b19aee456778853117c3e9dddb207acff5e535cb9a03863d20b1fb5",
				requestRef: "1af2bb3df21f698a1dfa7c9fa68cca32bf21ab9a3eb0dbc3a4ed22f9afc5092b",
				targetKind: "session_close",
				rawValues: ["sess-close", "control-token"],
			},
			{
				name: "close populated optionals",
				frame: {
					type: "session_close",
					requestId: "close-full",
					updateId: 104,
					chatId: "99",
					token: "control-token",
					force: true,
					target: {
						sessionId: "sess-close",
						tmuxSession: "gjc-sess-close",
						sessionStateFile: "/private/state.jsonl",
					},
				},
				target:
					'{"kind":"session_close","sessionId":"sess-close","tmuxSession":"gjc-sess-close","sessionStateFile":"/private/state.jsonl"}',
				request:
					'{"type":"session_close","target":{"kind":"session_close","sessionId":"sess-close","tmuxSession":"gjc-sess-close","sessionStateFile":"/private/state.jsonl"},"startupPromptRef":null,"modelPreset":null,"force":true}',
				hash: "cf6ca81580d64a3a2505521b6e5cee6515ffff411c4ba81b00b489602359f928",
				targetRef: "ae426efe866c7ca58465383b2f5856e855b8b037a09827077b0a8fe07da9f045",
				requestRef: "3a8cfeb8a3125616a57633d024ae1a604dc78f8531a4c761abfb0eeea0370d40",
				targetKind: "session_close",
				rawValues: ["sess-close", "gjc-sess-close", "/private/state.jsonl", "control-token"],
			},
			{
				name: "resume null path",
				frame: {
					type: "session_resume",
					requestId: "resume-null",
					updateId: 105,
					chatId: "99",
					token: "control-token",
					target: { sessionIdOrPrefix: "sess-resume" },
				},
				target: '{"kind":"session_resume","sessionIdOrPrefix":"sess-resume","path":null}',
				request:
					'{"type":"session_resume","target":{"kind":"session_resume","sessionIdOrPrefix":"sess-resume","path":null},"startupPromptRef":null,"modelPreset":null,"force":null}',
				hash: "cd41bb0e5f88e41b6ab29a7c203bcbeb35b10750bf93fd319231fdd953fd8b23",
				targetRef: "d3133775a34f9ff18afc3bc9a4617223d409ce79b277eca818ffd83cc61753cb",
				requestRef: "ebaa7d2329678fca55a4575cfebb2c0500e578fda56389e3de6f6d6e0121fefc",
				targetKind: "session_resume",
				rawValues: ["sess-resume", "control-token"],
			},
			{
				name: "resume populated path",
				frame: {
					type: "session_resume",
					requestId: "resume-full",
					updateId: 106,
					chatId: "99",
					token: "control-token",
					target: { sessionIdOrPrefix: "sess-resume", path: "/private/resume" },
				},
				target: '{"kind":"session_resume","sessionIdOrPrefix":"sess-resume","path":"/private/resume"}',
				request:
					'{"type":"session_resume","target":{"kind":"session_resume","sessionIdOrPrefix":"sess-resume","path":"/private/resume"},"startupPromptRef":null,"modelPreset":null,"force":null}',
				hash: "53aa22e8c08d897fcf59f8cb9b7f54b544d96e52ecfbaa693e72bf0fddc31a3c",
				targetRef: "532a5b3fac01dbff54568f667783ea5cb8a1eec79c52201e109086abd83fb2d9",
				requestRef: "b13fde62e5e408034ad64862024ba02a08817361b5dca9b19db4a4aa6f0e283d",
				targetKind: "session_resume",
				rawValues: ["sess-resume", "/private/resume", "control-token"],
			},
			{
				name: "modelPreset null",
				frame: createFrame({ updateId: 107, chatId: "99", target: { kind: "existing_path", path: "/model" } }),
				target: '{"kind":"existing_path","path":"/model"}',
				request:
					'{"type":"session_create","target":{"kind":"existing_path","path":"/model"},"startupPromptRef":null,"modelPreset":null,"force":null}',
				hash: "8d5a928195ceac8fadcbde7dffbe0cbf4967a73dd72156efbb0154eec279f124",
				targetRef: "254b1c1d23063013c81ec559076535da343d79bd12f08dfaeab44d2a23f2e0e7",
				requestRef: "e764345a7c11ebb0b77c30a85e288c3490c7fe9b07992d41a116a712383e2135",
				targetKind: "existing_path",
				rawValues: ["/model", "control-token"],
			},
			{
				name: "modelPreset present",
				frame: createFrame({
					updateId: 108,
					chatId: "99",
					target: { kind: "existing_path", path: "/model" },
					modelPreset: "codex-eco",
				}),
				target: '{"kind":"existing_path","path":"/model"}',
				request:
					'{"type":"session_create","target":{"kind":"existing_path","path":"/model"},"startupPromptRef":null,"modelPreset":"codex-eco","force":null}',
				hash: "380e8ce83da82443d65a8f3076f36d6e25340c9cab49969e7fc6b48a073b9d6c",
				targetRef: "254b1c1d23063013c81ec559076535da343d79bd12f08dfaeab44d2a23f2e0e7",
				requestRef: "39085791b74f37a4d04bb693b4beae019f71d7e715b4a33edeebddc4e388e826",
				targetKind: "existing_path",
				rawValues: ["/model", "codex-eco", "control-token"],
			},
		];

		for (const variant of variants) {
			expect(canonicalTarget(variant.frame)).toBe(variant.target);
			expect(canonicalRequest(variant.frame)).toBe(variant.request);
			expect(requestHash(variant.frame)).toBe(variant.hash);
			expect(auditRedactionRef(new Uint8Array(32).fill(1), "gjc.lifecycle.audit.v2.target\0", variant.target)).toBe(
				variant.targetRef,
			);
			expect(
				auditRedactionRef(new Uint8Array(32).fill(1), "gjc.lifecycle.audit.v2.request\0", variant.request),
			).toBe(variant.requestRef);

			const { deps: d, audit } = deps({ auditRedactionKey: new Uint8Array(32).fill(1) });
			await handleLifecycleRequest(variant.frame, d);
			const serialized = JSON.stringify(audit[0]);
			expect(serialized, variant.name).toBe(
				variant.audit ??
					`{"schemaVersion":2,"ts":"1970-01-01T00:00:01.000Z","chatRef":"f05b1a602d9038ea96b543dc8929a33d587f1f8b48af352460ffc0f81d178bdf","updateId":${variant.frame.updateId},"requestRef":"${variant.requestRef}","verb":"${variant.frame.type}","targetKind":"${variant.targetKind}","targetRef":"${variant.targetRef}","event":"rejected","reason":"unauthorized"}`,
			);
			for (const raw of variant.rawValues) expect(serialized, variant.name).not.toContain(raw);
		}
		expect(() => auditRedactionRef(new Uint8Array(), "domain", "value")).toThrow("invalid_audit_redaction_key");
	});
});

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
	it("propagates no startup prompt reference for supported prompt-less creation", async () => {
		let writtenPrompt: string | undefined;
		let spawnedRef: string | undefined;
		const { deps: d } = deps({
			writeStartupPrompt: async (_requestId, prompt) => {
				writtenPrompt = prompt;
				return undefined;
			},
			spawnCreate: async (_frame, ids) => {
				spawnedRef = ids.startupPromptRef;
				return {
					sessionId: ids.intendedSessionId,
					tmuxSession: `gjc-${ids.intendedSessionId}`,
					endpointUrl: "ws://127.0.0.1:5000",
					topicThreadId: "99",
				};
			},
		});
		const outcome = await handleLifecycleRequest(createFrame(), d);
		expect(outcome.status).toBe("ok");
		expect(writtenPrompt).toBeUndefined();
		expect(spawnedRef).toBeUndefined();
	});

	it("rejects empty immutable create ids before persistence or effects", async () => {
		let writes = 0;
		let spawns = 0;
		const { deps: d } = deps({
			store: {
				read: async () => ({ version: 1, entries: {} }),
				write: async () => {
					writes++;
				},
			},
			spawnCreate: async () => {
				spawns++;
				throw new Error("must not spawn");
			},
		});
		const outcome = await handleLifecycleRequest(createFrame({ lifecycleRequestId: "", intendedSessionId: "" }), d);
		expect(outcome).toMatchObject({ status: "error", reason: "invalid_target" });
		expect([writes, spawns]).toEqual([0, 0]);
	});
	it("emits only audit-v2 allowlisted fields with 64-hex references", async () => {
		const { deps: d, audit } = deps();
		await handleLifecycleRequest(createFrame({ modelPreset: "codex-eco" }), d);
		for (const event of audit) {
			expect(Object.keys(event).sort()).toEqual(
				(event.reason === undefined
					? [
							"chatRef",
							"event",
							"requestRef",
							"schemaVersion",
							"targetKind",
							"targetRef",
							"ts",
							"updateId",
							"verb",
						]
					: [
							"chatRef",
							"event",
							"reason",
							"requestRef",
							"schemaVersion",
							"targetKind",
							"targetRef",
							"ts",
							"updateId",
							"verb",
						]
				).sort(),
			);
			expect(event.chatRef).toMatch(/^[0-9a-f]{64}$/);
			expect(event.requestRef).toMatch(/^[0-9a-f]{64}$/);
			expect(event.targetRef).toMatch(/^[0-9a-f]{64}$/);
		}
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

	it("rejects a duplicate update id when only modelPreset differs", async () => {
		const { deps: d, store } = deps();
		await handleLifecycleRequest(createFrame(), d);
		const out = await handleLifecycleRequest(createFrame({ modelPreset: "codex-eco" }), {
			...d,
			store,
		});
		expect(out).toMatchObject({ status: "error", reason: "duplicate_conflict" });
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
	it("preserves cold restart mode on a durable duplicate re-ack", async () => {
		const { deps: d, store } = deps({
			resumeSession: async () => ({
				sessionId: "sess-x",
				tmuxSession: "gjc-sess-x",
				endpointUrl: "ws://127.0.0.1:5001",
				topicThreadId: "99",
				mode: "cold_restarted",
			}),
		});
		const frame: SessionResumeFrame = {
			type: "session_resume",
			requestId: "lc_cold",
			updateId: 202,
			chatId: PAIRED,
			token: "control-token",
			target: { sessionIdOrPrefix: "sess-x" },
		};
		await handleLifecycleRequest(frame, d);
		const duplicate = await handleLifecycleRequest(frame, { ...d, store });
		expect(duplicate).toMatchObject({ status: "ok", mode: "cold_restarted" });
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
	it("fails closed when close cannot confirm process disappearance", async () => {
		let closeCalls = 0;
		const {
			deps: d,
			audit,
			store,
		} = deps({
			closeSession: async () => {
				closeCalls++;
				return { processGone: false };
			},
		});
		const frame: SessionCloseFrame = {
			type: "session_close",
			requestId: "lc_c_uncertain",
			updateId: 303,
			chatId: PAIRED,
			token: "control-token",
			target: { sessionId: "sess-1", tmuxSession: "gjc-1" },
			force: true,
		};

		const out = await handleLifecycleRequest(frame, d);

		expect(out).toMatchObject({ status: "error", reason: "terminal_uncertain" });
		expect(closeCalls).toBe(1);
		expect((await store.read()).entries[`${PAIRED}:303`]).toMatchObject({
			state: "terminal_uncertain",
			reason: "terminal_uncertain",
			sessionId: "sess-1",
		});
		expect(audit.at(-1)).toMatchObject({ event: "terminal_uncertain", reason: "terminal_uncertain" });
		expect(await handleLifecycleRequest(frame, d)).toMatchObject({ status: "error", reason: "terminal_uncertain" });
		expect(closeCalls).toBe(1);
	});

	it("normalizes historical false close success without redispatching", async () => {
		const frame: SessionCloseFrame = {
			type: "session_close",
			requestId: "lc_c_historical_false",
			updateId: 304,
			chatId: PAIRED,
			token: "control-token",
			target: { sessionId: "sess-1", tmuxSession: "gjc-1" },
			force: true,
		};
		const { deps: d, store } = deps({
			store: memStore({
				version: 1,
				entries: {
					[`${PAIRED}:304`]: {
						requestHash: requestHash(frame),
						state: "success",
						requestId: frame.requestId,
						verb: "session_close",
						createdAt: 1,
						updatedAt: 1,
						targetSummary: { sessionId: "sess-1" },
						sessionId: "sess-1",
						processGone: false,
					},
				},
			}),
			closeSession: async () => {
				throw new Error("historical false success must not redispatch");
			},
		});

		expect(await handleLifecycleRequest(frame, d)).toMatchObject({ status: "error", reason: "terminal_uncertain" });
		expect((await store.read()).entries[`${PAIRED}:304`]).toMatchObject({
			state: "terminal_uncertain",
			reason: "terminal_uncertain",
		});
		expect((await store.read()).entries[`${PAIRED}:304`]?.processGone).toBeUndefined();
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
	it("rejects psmux create repeatedly before ledger, rate, prompt, or effects", async () => {
		let providers = 0;
		let reads = 0;
		let rates = 0;
		let prompts = 0;
		let spawns = 0;
		const { deps: d, audit } = deps({
			isPsmuxProvider: () => {
				providers++;
				return true;
			},
			store: {
				read: async () => {
					reads++;
					return { version: 1, entries: {} };
				},
				write: async () => {},
			},
			allowCreate: () => {
				rates++;
				return true;
			},
			writeStartupPrompt: async () => {
				prompts++;
				throw new Error("must not write prompt");
			},
			spawnCreate: async () => {
				spawns++;
				throw new Error("must not spawn");
			},
		});
		await expect(handleLifecycleRequest(createFrame(), d)).resolves.toMatchObject({
			status: "error",
			reason: "unsupported_platform",
		});
		await expect(handleLifecycleRequest(createFrame(), d)).resolves.toMatchObject({
			status: "error",
			reason: "unsupported_platform",
		});
		expect([providers, reads, rates, prompts, spawns]).toEqual([2, 0, 0, 0, 0]);
		expect(audit).toHaveLength(2);
		expect(audit).toEqual(
			audit.map(() =>
				expect.objectContaining({ schemaVersion: 2, event: "rejected", reason: "unsupported_platform" }),
			),
		);
	});
	it("rejects psmux resume and forced close before ledger or lifecycle effects", async () => {
		let reads = 0;
		let resumes = 0;
		let closes = 0;
		let providers = 0;
		const { deps: d } = deps({
			isPsmuxProvider: () => {
				providers++;
				return true;
			},
			store: {
				read: async () => {
					reads++;
					return { version: 1, entries: {} };
				},
				write: async () => {},
			},
			resumeSession: async () => {
				resumes++;
				throw new Error("must not resume");
			},
			closeSession: async () => {
				closes++;
				throw new Error("must not close");
			},
		});
		const resume: SessionResumeFrame = {
			type: "session_resume",
			requestId: "psmux-resume",
			updateId: 401,
			chatId: PAIRED,
			token: "control-token",
			target: { sessionIdOrPrefix: "sess" },
		};
		const close: SessionCloseFrame = {
			type: "session_close",
			requestId: "psmux-close",
			updateId: 402,
			chatId: PAIRED,
			token: "control-token",
			target: { sessionId: "sess" },
			force: true,
		};
		const nonForcedClose: SessionCloseFrame = {
			...close,
			requestId: "psmux-close-non-forced",
			updateId: 403,
			force: false,
		};
		await handleLifecycleRequest(resume, d);
		await handleLifecycleRequest(close, d);
		await handleLifecycleRequest(resume, d);
		const nonForced = await handleLifecycleRequest(nonForcedClose, d);
		expect(nonForced).toMatchObject({ status: "error", reason: "invalid_target" });
		expect([providers, reads, resumes, closes]).toEqual([3, 0, 0, 0]);
	});
	it("rejects startup prompt content before audit, ledger, rate limit, writer, or spawn effects", async () => {
		const calls = { audit: 0, read: 0, write: 0, rateLimit: 0, writer: 0, spawn: 0, resume: 0 };
		const { deps: d } = deps({
			store: {
				read: async () => {
					calls.read += 1;
					return { version: 1, entries: {} };
				},
				write: async () => {
					calls.write += 1;
				},
			},
			audit: () => {
				calls.audit += 1;
			},
			allowCreate: () => {
				calls.rateLimit += 1;
				return true;
			},
			writeStartupPrompt: async () => {
				calls.writer += 1;
				throw new Error("must not write");
			},
			spawnCreate: async () => {
				calls.spawn += 1;
				throw new Error("must not spawn");
			},
			resumeSession: async () => {
				calls.resume += 1;
				throw new Error("must not resume");
			},
		});
		const createOutcome = await handleLifecycleRequest(createFrame({ startupPromptRef: "SECRET" }), d);
		const resume: SessionResumeFrame = {
			type: "session_resume",
			requestId: "resume-prompt",
			updateId: 404,
			chatId: PAIRED,
			token: "control-token",
			target: { sessionIdOrPrefix: "sess" },
			startupPromptRef: "",
		};
		const resumeOutcome = await handleLifecycleRequest(resume, d);
		for (const outcome of [createOutcome, resumeOutcome]) {
			expect(outcome).toEqual({
				status: "error",
				reason: "invalid_target",
				message: "startup prompt capability transport is unavailable; retry without a startup prompt",
			});
		}
		expect(calls).toEqual({ audit: 0, read: 0, write: 0, rateLimit: 0, writer: 0, spawn: 0, resume: 0 });
	});
});
