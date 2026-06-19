import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { estimateMessageTokensHeuristic } from "../src/compaction/compaction";
import type { AgentMessage } from "../src/types";

const compactionSourcePath = path.join(import.meta.dir, "..", "src", "compaction", "compaction.ts");

describe("compaction native tokenizer absence", () => {
	it("does not retain native tokenizer loading hooks or estimateTokens aliases", async () => {
		const source = await Bun.file(compactionSourcePath).text();

		expect(source).not.toContain("createRequire");
		expect(source).not.toContain("countTokens");
		expect(source).not.toContain("@gajae-code/natives");
		expect(source).not.toContain("countMessageTokensNativeO200k");
		expect(source).not.toContain("nativeTokenizerEntrypoint");
		expect(source).not.toContain("estimateTokens =");
	});

	it("keeps small-session token estimates positive and deterministic without loading native tokenizers", () => {
		const message: AgentMessage = {
			role: "user",
			content: "small-session native-free tokenizer regression",
			timestamp: 0,
		};
		const first = estimateMessageTokensHeuristic(message);

		expect(first).toBeGreaterThan(0);
		expect(first).toBe(estimateMessageTokensHeuristic(message));
	});
});
