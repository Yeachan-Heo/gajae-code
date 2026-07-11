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

	it("caps Grok 4.5 and its official aliases at the documented high effort", () => {
		for (const modelId of ["grok-4.5", "grok-4.5-latest", "grok-build-latest"]) {
			const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"].map(requested => {
				const payload = sanitizePayload({ reasoning: { effort: requested } }, modelId, undefined, process.cwd());
				return (payload.reasoning as { effort: string }).effort;
			});

			expect(efforts).toEqual(["low", "low", "medium", "high", "high", "high"]);
		}
	});
});
