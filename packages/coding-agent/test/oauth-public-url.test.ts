import { describe, expect, it } from "bun:test";
import { assertPublicOAuthUrl } from "../src/runtime-mcp/oauth-public-url";

describe("assertPublicOAuthUrl", () => {
	it("rejects a loopback OAuth endpoint", async () => {
		await expect(assertPublicOAuthUrl("http://127.0.0.1/token")).rejects.toThrow(/non-public OAuth endpoint/);
	});
});
