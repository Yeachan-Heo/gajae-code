import { describe, expect, it } from "bun:test";
import { isDefaultOpenAIBaseUrl } from "../src/providers/openai-responses";

describe("isDefaultOpenAIBaseUrl", () => {
	it("recognizes https://api.openai.com/v1 as default", () => {
		expect(isDefaultOpenAIBaseUrl("https://api.openai.com/v1")).toBe(true);
	});

	it("recognizes https://api.openai.com as default", () => {
		expect(isDefaultOpenAIBaseUrl("https://api.openai.com")).toBe(true);
	});

	it("treats a custom-port API URL as default (hostname and pathname match, ignoring port)", () => {
		// With a custom port like :8443, the hostname is still api.openai.com and pathname is still /v1.
		// Both providers and compaction should treat it as default so a captured proxy is used.
		// This regression test ensures the fix aligns compaction with provider behavior.
		expect(isDefaultOpenAIBaseUrl("https://api.openai.com:8443/v1")).toBe(true);
	});

	it("treats a mixed-case hostname as default (ignores case)", () => {
		expect(isDefaultOpenAIBaseUrl("https://API.OpenAI.com/v1")).toBe(true);
	});

	it("treats non-api.openai.com hosts as non-default", () => {
		expect(isDefaultOpenAIBaseUrl("https://proxy.example.com/v1")).toBe(false);
	});

	it("treats malformed URLs gracefully", () => {
		expect(isDefaultOpenAIBaseUrl("not-a-url")).toBe(false);
	});

	it("treats v1 without trailing slash as default", () => {
		expect(isDefaultOpenAIBaseUrl("https://api.openai.com/v1")).toBe(true);
	});

	it("treats empty pathname as default", () => {
		expect(isDefaultOpenAIBaseUrl("https://api.openai.com")).toBe(true);
	});

	it("treats /v2 as non-default", () => {
		expect(isDefaultOpenAIBaseUrl("https://api.openai.com/v2")).toBe(false);
	});
});
