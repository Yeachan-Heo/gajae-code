import { describe, expect, test } from "bun:test";
import { summarizeEditToolActivity } from "@gajae-code/coding-agent/edit";
import { summarizeBashToolActivity } from "@gajae-code/coding-agent/tools/bash";
import { summarizeReadToolActivity } from "@gajae-code/coding-agent/tools/read";

describe("built-in tool safe summaries", () => {
	test("bash projects only the executable and output size", () => {
		const command = 'curl -H "authorization: Bearer sk-12345678901234567890" https://example.test';
		const output = "password=do-not-share\nsecond line";

		expect(summarizeBashToolActivity("args", { command })).toBe("curl");
		const result = summarizeBashToolActivity("result", { exitCode: 0, output });
		expect(result).toBe("exit=0, 2 lines, 33 bytes");
		expect(result).not.toContain("password");
		expect(result).not.toContain(output);
		expect(result!.length).toBeLessThanOrEqual(120);
	});

	test("read projects a local path and result size, never read content", () => {
		const content = "secret file body\nsecond line";
		expect(summarizeReadToolActivity("args", { path: "src/example.ts:10-20" })).toBe("src/example.ts:10-20");
		const result = summarizeReadToolActivity("result", { content: [{ type: "text", text: content }] });
		expect(result).toBe("2 lines, 28 bytes");
		expect(result).not.toContain("secret file body");
		expect(summarizeReadToolActivity("args", { path: "https://example.test/?password=secret" })).toBeUndefined();
	});

	test("edit projects its path and edit count, never patch content", () => {
		const oldText = "password=do-not-share";
		expect(
			summarizeEditToolActivity("args", {
				path: "src/example.ts",
				edits: [
					{ oldText, newText: "replacement" },
					{ oldText: "other", newText: "next" },
				],
			}),
		).toBe("src/example.ts, 2 edits");
		const result = summarizeEditToolActivity("result", {
			isError: false,
			details: { perFileResults: [{ diff: oldText }, { diff: "another patch" }] },
		});
		expect(result).toBe("applied, 2 files");
		expect(result).not.toContain(oldText);
		expect(
			summarizeEditToolActivity("args", { path: "https://example.test/?token=secret", edits: [] }),
		).toBeUndefined();
	});
});
