import { describe, expect, it } from "bun:test";
import { sanitizePayload } from "../src/defaults/gjc/extensions/grok-cli-vendor/src/payload/sanitize";

describe("Grok CLI payload sanitize", () => {
	it("strips replayed reasoning and unsupported Composer effort", () => {
		const payload = sanitizePayload(
			{
				input: [
					{ role: "system", content: "be terse" },
					{ type: "reasoning", content: "cached" },
					{ role: "user", content: "hello" },
				],
				include: ["reasoning.encrypted_content"],
				reasoning: { effort: "high" },
			},
			"grok-composer-2.5-fast",
			"session-1",
			process.cwd(),
		);
		expect(payload.input).toEqual([{ role: "user", content: "hello" }]);
		expect(payload.instructions).toBe("be terse");
		expect(payload.include).toBeUndefined();
		expect(payload.reasoning).toBeUndefined();
		expect(payload.prompt_cache_key).toBe("session-1");
	});
});
