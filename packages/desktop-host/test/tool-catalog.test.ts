import { describe, expect, test } from "bun:test";
import { projectToolCatalog } from "../src/tool-catalog";

describe("tools.list projection", () => {
	test("returns the SDK name lists in order, each name through the redactor", () => {
		const seen: string[] = [];
		const redact = (text: string) => {
			seen.push(text);
			return text.replaceAll("secret-token", "[redacted]");
		};
		const result = projectToolCatalog(
			{
				getAllToolNames: () => ["read", "mcp_secret-token_search", "bash"],
				getActiveToolNames: () => ["bash", "read"],
			},
			redact,
		);
		// tools.list is a projected control method: the Host emits this result without redacting it again.
		expect(result).toEqual({ available: ["read", "mcp_[redacted]_search", "bash"], active: ["bash", "read"] });
		expect(seen).toEqual(["read", "mcp_secret-token_search", "bash", "bash", "read"]);
	});
});
