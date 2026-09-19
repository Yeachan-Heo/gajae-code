import { describe, expect, it } from "bun:test";
import { classifyFallbackTrigger, transportFailureFacts } from "../src/utils/fallback-transport";

describe("HTTP/2 diagnostic facts", () => {
	it("retains native codes without granting fallback authority", () => {
		const facts = transportFailureFacts(
			Object.assign(new Error("private native message"), { code: "ERR_HTTP2_STREAM_ERROR" }),
		);
		expect(facts).toMatchObject({ kind: "transport", nativeErrorCode: "ERR_HTTP2_STREAM_ERROR" });
		expect(classifyFallbackTrigger(facts)).toEqual({ class: "other" });
		expect(transportFailureFacts(structuredClone(facts))).toEqual(facts);
		expect(JSON.stringify(facts)).not.toContain("private native message");
	});

	it("round-trips reset diagnostics without interpreting them as HTTP status", () => {
		const facts = transportFailureFacts({ http2RstCode: 8 });
		expect(facts).toMatchObject({ kind: "transport", http2RstCode: 8 });
		expect(transportFailureFacts(structuredClone(facts))).toEqual(facts);
		expect(classifyFallbackTrigger(facts)).toEqual({ class: "other" });
		for (const value of [-1, NaN, Infinity, 0.5, "8"]) {
			expect(transportFailureFacts({ http2RstCode: value })).toBeUndefined();
		}
	});
});
