import { describe, expect, test } from "bun:test";
import { ModeGate } from "../../../src/modes/controllers/mode-gate";

describe("ModeGate", () => {
	test("permits re-entry to the active mode but rejects the competing mode", () => {
		const gate = new ModeGate();

		expect(gate.enter("goal")).toBe(true);
		expect(gate.enter("goal")).toBe(true);
		expect(gate.enter("plan")).toBe(false);
		expect(gate.activeMode).toBe("goal");
	});

	test("releases the active mode only", () => {
		const gate = new ModeGate();
		gate.enter("plan");

		gate.exit("goal");
		expect(gate.activeMode).toBe("plan");
		gate.exit("plan");
		expect(gate.activeMode).toBeUndefined();
		expect(gate.enter("goal")).toBe(true);
	});
});
