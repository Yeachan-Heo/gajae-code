import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { inboundReactionRetractPayload } from "../src/sdk/bus/inbound-reaction-ordering";
import { notificationInboundAdmission } from "../src/sdk/bus/index";

const root = path.resolve(import.meta.dir, "..");
const bus = fs.readFileSync(path.join(root, "src/sdk/bus/index.ts"), "utf8");
const daemon = fs.readFileSync(path.join(root, "src/sdk/bus/telegram-daemon.ts"), "utf8");

test("production inbound gates emit explicit drop acknowledgements before returning", () => {
	const fencedStart = bus.indexOf('admission.outcome === "drop" && admission.reason === "inbound_fenced"');
	const suspendedStart = bus.indexOf('if (admission.outcome === "drop")', fencedStart + 1);
	expect(fencedStart).toBeGreaterThan(0);
	expect(bus.slice(fencedStart, suspendedStart)).toContain('sendInboundAck(inbound.connectionId, inbound, "dropped"');
	expect(bus.slice(fencedStart, suspendedStart)).toContain("return;");
	const suspendedGate = bus.slice(suspendedStart, suspendedStart + 1_600);
	expect(suspendedGate).toContain('sendInboundAck(authenticatedInbound.connectionId, authenticatedInbound, "dropped"');
	expect(suspendedGate).toContain("return;");
});

test("production admission defers valid suspended controls instead of dropping them", () => {
	// A policy-suspended notification-origin control_command is deferred to
	// activate(), so it must NOT take the dropped-ack branch.
	expect(
		notificationInboundAdmission({
			inboundFenced: false,
			policySuspended: true,
			notificationOrigin: true,
			controlCommand: true,
		}),
	).toEqual({ outcome: "defer", reason: "policy_suspended" });
	// A policy-suspended user_message from the same origin IS dropped.
	expect(
		notificationInboundAdmission({
			inboundFenced: false,
			policySuspended: true,
			notificationOrigin: true,
			controlCommand: false,
		}),
	).toEqual({ outcome: "drop", reason: "policy_suspended" });

	// The production drop gate never sends a dropped ack on the defer path, and
	// the defer path still enqueues the deferred control for later execution.
	const deferStart = bus.indexOf('if (admission.outcome === "defer")');
	expect(deferStart).toBeGreaterThan(0);
	const dropStart = bus.indexOf('if (admission.outcome === "drop")', deferStart);
	expect(dropStart).toBeGreaterThan(deferStart);
	const deferGate = bus.slice(deferStart, dropStart);
	expect(deferGate).toContain("deferredInboundControls.push");
	expect(deferGate).not.toContain("sendInboundAck");
	expect(deferGate).toContain("return;");
	const dropGate = bus.slice(dropStart, dropStart + 1_200);
	expect(dropGate).toContain('sendInboundAck(authenticatedInbound.connectionId, authenticatedInbound, "dropped"');
	expect(dropGate).toContain("return;");
	// Only the drop path carries the policy-suspension diagnostic.
	expect(deferGate).not.toContain("notification policy is suspended");
});

test("production daemon queues only on accepted and retracts rejected or dropped", () => {
	expect(daemon).toContain('if (state === "accepted") return "queued"');
	expect(daemon).toContain('if (state === "rejected" || state === "dropped") return "retract"');
	expect(daemon).not.toContain("setReaction(inbound.messageId, QUEUED_REACTION");
});

test("production daemon serializes reaction transitions and retracts with the empty reaction list", () => {
	// Per-update serialization and terminal monotonicity come from the shared sequencer.
	expect(daemon).toContain("#inboundReactions.apply(updateId, {");
	// Retraction routes through the empty-list payload, not an empty emoji string.
	expect(daemon).toContain("inboundReactionRetractPayload(this.opts.chatId, messageId)");
	expect(daemon).not.toMatch(/setReaction\([^)]*,\s*""\s*[,)]/);
	expect(JSON.stringify(inboundReactionRetractPayload("42", 1))).toContain('"reaction":[]');
});
