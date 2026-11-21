import { describe, it, expect } from "bun:test";
import { codexRoutingHint } from "../src/providers/openai-codex/constants";
import { withCodexRoutingFieldsFirst } from "../src/providers/openai-codex/request-transformer";

describe("Codex routing hint header", () => {
	it("builds routing hint with model only", () => {
		const hint = codexRoutingHint("gpt-4o", undefined);
		expect(hint).toBe("model=gpt-4o");
	});

	it("builds routing hint with model and service_tier", () => {
		const hint = codexRoutingHint("gpt-4o", "ultrafast");
		expect(hint).toBe("model=gpt-4o;tier=ultrafast");
	});

	it("builds routing hint with model and null service_tier", () => {
		const hint = codexRoutingHint("gpt-4o", null);
		expect(hint).toBe("model=gpt-4o");
	});

	it("builds routing hint with model and priority service_tier", () => {
		const hint = codexRoutingHint("gpt-4o", "priority");
		expect(hint).toBe("model=gpt-4o;tier=priority");
	});

	it("builds routing hint for unsupported model (ultrafast omitted)", () => {
		const hint = codexRoutingHint("gpt-4-turbo", undefined);
		expect(hint).toBe("model=gpt-4-turbo");
	});
});

describe("Codex field ordering", () => {
	it("reorders fields to put routing fields first", () => {
		const body = {
			input: [{ type: "message", role: "user", content: "test" }],
			model: "gpt-4o",
			stream: true,
			service_tier: "ultrafast",
			previous_response_id: "resp_123",
			type: "response.create",
			include: ["reasoning.encrypted_content"],
		};

		const ordered = withCodexRoutingFieldsFirst(body);

		// Get the keys in order
		const keys = Object.keys(ordered);

		// Verify routing fields come first
		const routingFieldsIndex = {
			type: keys.indexOf("type"),
			model: keys.indexOf("model"),
			stream: keys.indexOf("stream"),
			service_tier: keys.indexOf("service_tier"),
			previous_response_id: keys.indexOf("previous_response_id"),
			input: keys.indexOf("input"),
			include: keys.indexOf("include"),
		};

		// All routing fields should come before input
		expect(routingFieldsIndex.type < routingFieldsIndex.input).toBe(true);
		expect(routingFieldsIndex.model < routingFieldsIndex.input).toBe(true);
		expect(routingFieldsIndex.stream < routingFieldsIndex.input).toBe(true);
		expect(routingFieldsIndex.service_tier < routingFieldsIndex.input).toBe(true);
		expect(routingFieldsIndex.previous_response_id < routingFieldsIndex.input).toBe(true);

		// Verify order of routing fields
		expect(routingFieldsIndex.type < routingFieldsIndex.model).toBe(true);
		expect(routingFieldsIndex.model < routingFieldsIndex.stream).toBe(true);
		expect(routingFieldsIndex.stream < routingFieldsIndex.service_tier).toBe(true);
		expect(routingFieldsIndex.service_tier < routingFieldsIndex.previous_response_id).toBe(true);
	});

	it("preserves values during reordering", () => {
		const body = {
			input: [{ type: "message", role: "user", content: "hello" }],
			model: "gpt-4o",
			stream: true,
			service_tier: "ultrafast",
			previous_response_id: "resp_123",
			type: "response.create",
			metadata: { custom: "value" },
		};

		const ordered = withCodexRoutingFieldsFirst(body);

		expect(ordered.model).toBe("gpt-4o");
		expect(ordered.stream).toBe(true);
		expect(ordered.service_tier).toBe("ultrafast");
		expect(ordered.previous_response_id).toBe("resp_123");
		expect(ordered.type).toBe("response.create");
		expect(ordered.metadata).toEqual({ custom: "value" });
	});

	it("handles missing routing fields gracefully", () => {
		const body = {
			input: [{ type: "message", role: "user", content: "test" }],
			model: "gpt-4o",
			type: "response.create",
		};

		const ordered = withCodexRoutingFieldsFirst(body);

		expect(ordered.model).toBe("gpt-4o");
		expect(ordered.type).toBe("response.create");
		expect(ordered.input).toBeDefined();
		expect(ordered.stream).toBeUndefined();
		expect(ordered.service_tier).toBeUndefined();
		expect(ordered.previous_response_id).toBeUndefined();
	});
});
