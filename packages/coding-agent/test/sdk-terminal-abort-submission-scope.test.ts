import { describe, expect, it } from "bun:test";
import { terminalAbortAddressesSubmission } from "../src/sdk/bus";

/**
 * A terminal abort is scoped to the requesting connection's own prompt, and broker-authorized
 * operator authority is the documented exception ("operator authority changes only connection
 * ownership, never those settlement proofs"). Every SDK request arrives on its own connection,
 * so without that override in the active-submission lookup an operator abort from the aborting
 * client found no submission of its own and answered `no_active_turn` while the turn was
 * verifiably running (`status` in flight, `turn.steer` accepted).
 */

const requester = "connection:2";
const other = "connection:1";

function addresses(submission: { connectionId?: string; terminal: boolean }, operatorAuthorized = false): boolean {
	return terminalAbortAddressesSubmission({ connectionId: requester, operatorAuthorized, submission });
}

describe("terminal abort submission scope", () => {
	it("addresses the requesting connection's own live submission", () => {
		expect(addresses({ connectionId: requester, terminal: false })).toBe(true);
	});

	it("does not address another connection's live submission", () => {
		expect(addresses({ connectionId: other, terminal: false })).toBe(false);
	});

	it("does not address a submission that already reached a terminal state", () => {
		expect(addresses({ connectionId: requester, terminal: true })).toBe(false);
		expect(addresses({ connectionId: other, terminal: true }, true)).toBe(false);
	});

	/** The override under test: broker-authorized operator authority beats connection ownership. */
	it("addresses another connection's live submission under operator authority", () => {
		expect(addresses({ connectionId: other, terminal: false }, true)).toBe(true);
	});

	/**
	 * Scope guard: a submission with no connection recorded (a surface driven without a
	 * requester connection) is addressed only by the ordinary connection match, so the
	 * operator override cannot widen a request that has no connection at all.
	 */
	it("keeps an unattributed submission behind the ordinary match", () => {
		expect(addresses({ terminal: false })).toBe(false);
		expect(addresses({ terminal: false }, true)).toBe(true);
		expect(
			terminalAbortAddressesSubmission({
				connectionId: undefined,
				operatorAuthorized: false,
				submission: { terminal: false },
			}),
		).toBe(true);
	});
});
