import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveReadPath } from "@gajae-code/coding-agent/tools/path-utils";
import {
	DEFAULT_FILE_MENTION_INLINE_BYTES,
	generateFileMentionMessages,
} from "@gajae-code/coding-agent/utils/file-mentions";

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

describe("generateFileMentionMessages duplicate suppression + inline cap (Finding 5)", () => {
	function files(messages: Awaited<ReturnType<typeof generateFileMentionMessages>>) {
		const m = messages[0];
		if (m?.role !== "fileMention") throw new Error("expected file mention message");
		return m.files;
	}

	test("same path mentioned twice in one batch adds full body once then a compact note", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "a.txt"), "alpha body");

		const result = files(await generateFileMentionMessages(["a.txt", "a.txt"], cwd));
		expect(result).toHaveLength(2);
		expect(result[0]?.content).toContain("alpha body");
		expect(result[0]?.duplicate).toBeUndefined();
		expect(result[1]?.duplicate).toBe(true);
		expect(result[1]?.content).toContain("already shown");
		expect(result[1]?.content).not.toContain("alpha body");
	});

	test("path already shown recently gets a compact duplicate note", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "b.txt"), "beta body");
		const recentlyShownPaths = new Set([resolveReadPath("b.txt", cwd)]);

		const result = files(await generateFileMentionMessages(["b.txt"], cwd, { recentlyShownPaths }));
		expect(result).toHaveLength(1);
		expect(result[0]?.duplicate).toBe(true);
		expect(result[0]?.content).not.toContain("beta body");
	});

	test("distinct paths are not suppressed", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "c.txt"), "gamma");
		await Bun.write(path.join(cwd, "d.txt"), "delta");

		const result = files(await generateFileMentionMessages(["c.txt", "d.txt"], cwd));
		expect(result).toHaveLength(2);
		expect(result.every(f => !f.duplicate)).toBe(true);
	});

	test("inline cap truncates large mentions below the configured limit", async () => {
		const cwd = await createTempDir();
		const big = `${Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n")}`;
		await Bun.write(path.join(cwd, "big.txt"), big);

		const capped = files(await generateFileMentionMessages(["big.txt"], cwd, { maxInlineBytes: 4 * 1024 }));
		expect(Buffer.byteLength(capped[0]?.content ?? "", "utf-8")).toBeLessThan(6 * 1024);

		// Default cap is below the 50KB read-tool cap.
		expect(DEFAULT_FILE_MENTION_INLINE_BYTES).toBeLessThan(50 * 1024);
		const defaulted = files(await generateFileMentionMessages(["big.txt"], cwd));
		expect(Buffer.byteLength(defaulted[0]?.content ?? "", "utf-8")).toBeLessThanOrEqual(
			DEFAULT_FILE_MENTION_INLINE_BYTES + 2048,
		);
	});
});
