import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateFileMentionMessages } from "@gajae-code/coding-agent/utils/file-mentions";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-file-mentions-"));
	tempDirs.push(dir);
	return dir;
}

describe("generateFileMentionMessages path resolution", () => {
	test("prefers exact path over fuzzy candidates", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "httpserap"), "exact file");
		await fs.mkdir(path.join(cwd, "http_server_api_tests"), { recursive: true });
		await Bun.write(path.join(cwd, "http_server_api_tests", "spec.txt"), "spec");

		const messages = await generateFileMentionMessages(["httpserap"], cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files).toHaveLength(1);
		expect(message.files[0]?.path).toBe("httpserap");
		expect(message.files[0]?.content).toContain("exact file");
	});

	test("resolves unique prefix match", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
		await Bun.write(path.join(cwd, "docs", "readme.md"), "hello");

		const messages = await generateFileMentionMessages(["docs/rea"], cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files[0]?.path).toBe("docs/readme.md");
		expect(message.files[0]?.content).toContain("hello");
	});

	test("resolves fuzzy match for segmented names", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "http_server_api_tests"), { recursive: true });
		await Bun.write(path.join(cwd, "http_server_api_tests", "case.ts"), "ok");

		const messages = await generateFileMentionMessages(["httpserap"], cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files[0]?.path).toBe("http_server_api_tests");
		expect(message.files[0]?.content).toContain("case.ts");
	});

	test("returns no message for ambiguous or short fuzzy queries", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "spec-alpha.txt"), "a");
		await Bun.write(path.join(cwd, "spec-beta.txt"), "b");
		await Bun.write(path.join(cwd, "alphabet.txt"), "c");

		const ambiguous = await generateFileMentionMessages(["spec"], cwd);
		expect(ambiguous).toHaveLength(0);

		const shortQuery = await generateFileMentionMessages(["ab"], cwd);
		expect(shortQuery).toHaveLength(0);
	});
});
