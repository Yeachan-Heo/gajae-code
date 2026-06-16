import { describe, expect, it } from "bun:test";
import { parseBridgeEndpoints } from "../../src/modes/bridge/bridge-mode";

describe("parseBridgeEndpoints", () => {
	it("returns undefined for empty/whitespace/undefined (fail-closed default)", () => {
		expect(parseBridgeEndpoints(undefined)).toBeUndefined();
		expect(parseBridgeEndpoints("")).toBeUndefined();
		expect(parseBridgeEndpoints("   ")).toBeUndefined();
	});

	it('enables all matrix keys for "all" (case-insensitive)', () => {
		expect(parseBridgeEndpoints("all")).toEqual({
			events: true,
			commands: true,
			control: true,
			uiResponses: true,
			hostToolResults: true,
			hostUriResults: true,
		});
		expect(parseBridgeEndpoints(" ALL ")).toEqual(parseBridgeEndpoints("all"));
	});

	it("enables only the listed valid keys", () => {
		expect(parseBridgeEndpoints("events,commands,control")).toEqual({
			events: true,
			commands: true,
			control: true,
		});
	});

	it("ignores blank list entries", () => {
		expect(parseBridgeEndpoints("events, ,commands")).toEqual({
			events: true,
			commands: true,
		});
	});

	it("throws on an invalid key", () => {
		expect(() => parseBridgeEndpoints("events,bogus")).toThrow("Invalid GJC_BRIDGE_ENDPOINTS entry: bogus");
	});
});
