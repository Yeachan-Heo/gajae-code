import { describe, expect, it } from "bun:test";

describe("retry budget settings schema", () => {
	it("registers provider request and stream retry knobs with bounded defaults", async () => {
		const schema = await Bun.file(new URL("../src/config/settings-schema.ts", import.meta.url)).text();

		expect(schema).toContain('"retry.requestMaxRetries"');
		expect(schema).toContain('"retry.streamMaxRetries"');
		expect(schema).toContain("requestMaxRetries: number;");
		expect(schema).toContain("streamMaxRetries: number;");
		expect(schema).toContain("default: 5");
	});
});
