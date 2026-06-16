import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { estimateTokens } from "../src/compaction/compaction";
import type { AgentMessage } from "../src/types";

const compactionSourcePath = path.join(import.meta.dir, "..", "src", "compaction", "compaction.ts");

describe("compaction native tokenizer loading", () => {
	it("loads the native tokenizer lazily through the sibling native entrypoint", () => {
		const message: AgentMessage = {
			role: "user",
			content: "compiled binary native tokenizer smoke",
			timestamp: 0,
		};

		expect(estimateTokens(message)).toBeGreaterThan(0);
	});

	it("does not use a package-name dynamic require for @gajae-code/natives", async () => {
		const source = await Bun.file(compactionSourcePath).text();

		expect(source).toContain('const SOURCE_NATIVE_TOKENIZER_ENTRYPOINT = "../../../natives/native/index.js";');
		expect(source).toContain(
			'const COMPILED_NATIVE_TOKENIZER_ENTRYPOINT = "/$bunfs/root/packages/natives/native/index.js";',
		);
		expect(source).toContain("requireFromCompaction(nativeTokenizerEntrypoint())");
		expect(source).not.toContain('requireFromHere("@gajae-code/natives")');
		expect(source).not.toContain('require("@gajae-code/natives")');
	});
});
