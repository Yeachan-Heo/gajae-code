import { describe, expect, it } from "bun:test";
import { rpcError, rpcSuccess } from "../../src/modes/shared/agent-wire/responses";

describe("agent-wire RPC response helpers", () => {
	it("builds success responses without data", () => {
		expect(rpcSuccess("req-1", "prompt")).toEqual({
			id: "req-1",
			type: "response",
			command: "prompt",
			success: true,
		});
	});

	it("builds success responses with data, including null", () => {
		expect(rpcSuccess("req-2", "cycle_model", null)).toEqual({
			id: "req-2",
			type: "response",
			command: "cycle_model",
			success: true,
			data: null,
		});
		expect(rpcSuccess(undefined, "get_available_models", { models: [] })).toEqual({
			id: undefined,
			type: "response",
			command: "get_available_models",
			success: true,
			data: { models: [] },
		});
	});

	it("builds error responses", () => {
		expect(rpcError("req-3", "parse", "bad json")).toEqual({
			id: "req-3",
			type: "response",
			command: "parse",
			success: false,
			error: "bad json",
		});
	});
});
