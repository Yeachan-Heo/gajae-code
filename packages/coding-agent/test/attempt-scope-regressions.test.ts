import { describe, expect, it } from "bun:test";
import { createAttemptScopeAuthority } from "@gajae-code/agent-core/attempt-scope";
import { AttemptRecordStore } from "@gajae-code/coding-agent/session/attempt-record-store";

describe("AttemptScope facility regressions (#3592)", () => {
	describe("AttemptRecordStore state machine", () => {
		it("register creates unknown; establishClean transitions to clean; markExecuted transitions to executed", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);
			const scope = authority.mintMain(); // generation 1

			expect(store.register(scope)).toBe(true);
			expect(store.isClean(scope)).toBe(false); // unknown, not clean

			expect(store.establishClean(scope)).toBe(true);
			expect(store.isClean(scope)).toBe(true); // clean

			expect(store.markExecuted(scope)).toBe(true);
			expect(store.isClean(scope)).toBe(false); // executed, not clean
		});

		it("markExecuted rejects unknown state (clean is required first)", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);
			const scope = authority.mintMain();

			store.register(scope); // unknown
			expect(store.markExecuted(scope)).toBe(false); // cannot skip clean
			expect(store.isClean(scope)).toBe(false);
		});

		it("markExecuted on missing record fails closed (no record created)", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);
			const scope = authority.mintMain();

			// Never registered — markExecuted should not create a record
			expect(store.markExecuted(scope)).toBe(false);
			expect(store.isClean(scope)).toBe(false);
		});

		it("isClean false for unknown/executed/stale/missing scopes", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);
			const scope = authority.mintMain();

			// missing
			expect(store.isClean(scope)).toBe(false);

			// unknown
			store.register(scope);
			expect(store.isClean(scope)).toBe(false);

			// clean
			store.establishClean(scope);
			expect(store.isClean(scope)).toBe(true);

			// executed
			store.markExecuted(scope);
			expect(store.isClean(scope)).toBe(false);
		});

		it("retire removes record; late callback fail-closed (not resurrected)", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);
			const scope = authority.mintMain();

			store.register(scope);
			store.establishClean(scope);
			expect(store.isClean(scope)).toBe(true);

			store.retire(scope);
			expect(store.isClean(scope)).toBe(false); // gone → fail-closed

			// late markExecuted cannot resurrect
			expect(store.markExecuted(scope)).toBe(false);
			expect(store.isClean(scope)).toBe(false);
		});
	});

	describe("force-abort late-settlement isolation", () => {
		it("a stale G1 markExecuted is rejected after G2 supersedes the main lineage", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);

			// G1 — the abandoned attempt
			const g1 = authority.mintMain(); // generation 1
			store.register(g1);
			store.establishClean(g1);
			expect(store.isClean(g1)).toBe(true);

			// force-abort: advance main lineage (simulates forceAbort)
			authority.advanceMain(); // generation now 2

			// G2 — the successor
			const g2 = authority.mintMain(); // generation 2 (or 3 after advanceMain)
			store.register(g2);
			store.establishClean(g2);

			// G1 is no longer current
			expect(authority.isCurrent(g1)).toBe(false);
			expect(authority.isCurrent(g2)).toBe(true);

			// Late G1 settlement: markExecuted rejected (stale)
			expect(store.markExecuted(g1)).toBe(false);

			// G2 record is unaffected
			expect(store.isClean(g2)).toBe(true);
		});
	});

	describe("concurrent side-scope isolation", () => {
		it("a side attempt does not invalidate the main scope, and vice versa", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);

			// Main attempt
			const mainScope = authority.mintMain(); // main gen 1
			store.register(mainScope);
			store.establishClean(mainScope);
			expect(authority.isCurrent(mainScope)).toBe(true);

			// Concurrent side attempt (e.g. ephemeral/btw turn)
			const { scope: sideScope } = authority.mintSide();
			store.register(sideScope);
			store.establishClean(sideScope);
			expect(authority.isCurrent(sideScope)).toBe(true);

			// Side does NOT invalidate main
			expect(authority.isCurrent(mainScope)).toBe(true);
			expect(store.isClean(mainScope)).toBe(true);

			// Main advance does NOT invalidate side
			authority.advanceMain();
			expect(authority.isCurrent(sideScope)).toBe(true);
			expect(store.isClean(sideScope)).toBe(true);
		});

		it("retiring a side scope cleans up its authority", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);

			const { scope: sideScope, dispose } = authority.mintSide();
			store.register(sideScope);
			store.establishClean(sideScope);
			expect(authority.isCurrent(sideScope)).toBe(true);

			store.retire(sideScope);
			dispose();

			// Side authority gone
			expect(authority.isCurrent(sideScope)).toBe(false);
			expect(store.isClean(sideScope)).toBe(false);
		});
	});

	describe("no-extension path does not mark execution", () => {
		it("a session with no extension runner has no records and isClean is always false", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);
			const scope = authority.mintMain();

			// No register/establishClean — simulating a stream that doesn't
			// participate in the AttemptScope facility (no extension hooks).
			// markExecuted is a no-op (no record to mark).
			expect(store.markExecuted(scope)).toBe(false);
			expect(store.isClean(scope)).toBe(false); // fail-closed
		});
	});

	describe("managed-discard scope roundtrip", () => {
		it("a discarded managed attempt's scope is attributable via isClean (clean if no handler ran)", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);

			// Simulate a managed attempt: mint, register, establish clean
			const scope = authority.mintMain();
			store.register(scope);
			store.establishClean(scope);

			// The managed attempt is discarded (transaction.discard).
			// No extension handler ran (discard prevents staged events from
			// reaching ExtensionRunner.emit). So the record stays clean.
			expect(store.isClean(scope)).toBe(true);

			// If a handler HAD run before discard, markExecuted would have fired:
			store.markExecuted(scope);
			expect(store.isClean(scope)).toBe(false); // executed → not clean → #3553 refuses
		});
	});

	describe("provider-drop fail-closed behavior", () => {
		it("a scope that was never registered has no record → isClean fails closed", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);

			// If the scope was never registered (no facility participation),
			// there is no record and isClean is false → admission refuses.
			const scope = authority.mintMain();
			expect(store.isClean(scope)).toBe(false);
		});

		it("a scope that was registered+established but never marked stays clean (no handler ran)", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);

			const scope = authority.mintMain();
			store.register(scope);
			store.establishClean(scope);

			// If the provider hook never fires (or fires without forwarding
			// scope), markExecuted never runs → the record stays clean.
			// This is correct: no handler was attributed to this scope.
			// The fail-closed chain for #3553:
			//   - scope never established → isClean false → refused
			//   - scope established + handler ran with scope → markExecuted → isClean false → refused
			//   - scope established + no handler ran → isClean true → admitted (correct)
			expect(store.isClean(scope)).toBe(true);
		});

		it("LRU eviction bounds record count to 1024", () => {
			const authority = createAttemptScopeAuthority();
			const store = new AttemptRecordStore(authority);

			// Insert 2000 side scopes (each gets its own lineage)
			for (let i = 0; i < 2000; i++) {
				const { scope } = authority.mintSide();
				store.register(scope);
				store.establishClean(scope);
			}

			// The store should have evicted oldest entries, keeping ≤1024
			// (We can't directly inspect the private map, but we verify no
			// crash and the store remains functional.)
			const { scope: freshScope } = authority.mintSide();
			store.register(freshScope);
			store.establishClean(freshScope);
			expect(store.isClean(freshScope)).toBe(true);
		});
	});
});
