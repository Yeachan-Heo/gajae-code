import { afterEach, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import { resolveReadPath } from "@gajae-code/coding-agent/tools/path-utils";
import {
	DEFAULT_FILE_MENTION_INLINE_BYTES,
	generateFileMentionMessages,
	isCanonicalWindowsPathWithin,
} from "@gajae-code/coding-agent/utils/file-mentions";
import { directoryCaseSensitive } from "@gajae-code/natives";

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

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
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

	test("ignores mentions whose letters only appear scattered mid-word in a path", async () => {
		const cwd = await createTempDir();
		const nested = path.join(cwd, "gjc-operation-cancel", "packages", "natives", "test");
		await fs.mkdir(nested, { recursive: true });
		await Bun.write(path.join(nested, "memory-guard-build-wiring.test.ts"), "unrelated");

		// A chat handle such as "(@pepemewng)" is a plain subsequence of that path
		// but does not spell any of its segment prefixes.
		const messages = await generateFileMentionMessages(["pepemewng"], cwd);
		expect(messages).toHaveLength(0);
	});

	test("resolves fuzzy match when segment prefixes need backtracking", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "ab-abcde.txt"), "backtracked");

		// Taking "ab" from the first segment leaves "cdetx", which no later segment
		// starts with; the resolver must skip that segment and take "abcde" + "tx".
		const messages = await generateFileMentionMessages(["abcdetx"], cwd);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		if (message?.role !== "fileMention") {
			throw new Error("expected file mention message");
		}
		expect(message.files[0]?.path).toBe("ab-abcde.txt");
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

describe("resolveReadPath macOS screenshot recovery", () => {
	const NNBSP = "\u202f";

	test("recovers the narrow no-break space before AM/PM for any following separator", async () => {
		const cwd = await createTempDir();
		const cases = [
			`Screenshot 2026-07-26 at 11.23.30${NNBSP}PM.png`,
			`Screenshot 2026-07-26 at 11.23.31${NNBSP}PM-1785075812409.png`,
			`Screenshot 2026-07-26 at 11.23.32${NNBSP}AM_2.png`,
		];
		for (const name of cases) {
			await Bun.write(path.join(cwd, name), "x");
			// The model normalizes NNBSP to a plain space before the tool sees the path.
			const typed = path.join(cwd, name.replace(NNBSP, " "));
			expect(resolveReadPath(typed, cwd)).toBe(path.join(cwd, name));
		}
	});

	test("leaves a plain-space path alone when AM/PM is part of a longer word", async () => {
		const cwd = await createTempDir();
		const typed = path.join(cwd, "a PMX.png");
		expect(resolveReadPath(typed, cwd)).toBe(typed);
	});
});

describe("generateFileMentionMessages duplicate suppression + inline cap (Finding 5)", () => {
	function files(messages: AgentMessage[]) {
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
		const big = "x".repeat(15 * 1024);
		await Bun.write(path.join(cwd, "big.txt"), big);

		const capped = files(await generateFileMentionMessages(["big.txt"], cwd, { maxInlineBytes: 4 * 1024 }));
		expect(Buffer.byteLength(capped[0]?.content ?? "", "utf-8")).toBeLessThan(6 * 1024);

		expect(DEFAULT_FILE_MENTION_INLINE_BYTES).toBe(10 * 1024);
		const defaulted = files(await generateFileMentionMessages(["big.txt"], cwd));
		const content = defaulted[0]?.content ?? "";
		const inlineBody = content.split("\n\n[Line 1 is", 1)[0] ?? "";
		expect(Buffer.byteLength(inlineBody, "utf-8")).toBeLessThanOrEqual(DEFAULT_FILE_MENTION_INLINE_BYTES);
		expect(inlineBody).toHaveLength(DEFAULT_FILE_MENTION_INLINE_BYTES);
	});
});

function symlinkCreationAllowed(): boolean {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "pi-symlink-probe-"));
	try {
		fsSync.symlinkSync(dir, path.join(dir, "link"));
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES") return false;
		throw error;
	} finally {
		fsSync.rmSync(dir, { recursive: true, force: true });
	}
}

const canCreateSymlink = symlinkCreationAllowed();

function mentionText(messages: AgentMessage[]): string {
	return messages
		.filter(message => message.role === "fileMention")
		.flatMap(message => (message.role === "fileMention" ? message.files.map(file => file.content) : []))
		.join("\n");
}

describe("generateFileMentionMessages workspace boundary", () => {
	test("checks canonical Windows path components case-sensitively", () => {
		expect(isCanonicalWindowsPathWithin("C:\\work\\Workspace", "C:\\work\\Workspace\\inside.txt")).toBe(true);
		expect(isCanonicalWindowsPathWithin("C:\\work\\Workspace", "C:\\work\\workspace\\secret.txt")).toBe(false);
		expect(isCanonicalWindowsPathWithin("C:\\work\\Workspace", "C:\\work\\WorkspaceSibling\\secret.txt")).toBe(false);
		expect(isCanonicalWindowsPathWithin("C:\\work\\Workspace", "D:\\work\\Workspace\\secret.txt")).toBe(false);
	});

	test("holds seeded Windows containment properties (seed 0x5eed6837)", () => {
		const random = seededRandom(0x5eed6837);
		const randomInt = (max: number): number => Math.floor(random() * max);

		for (let caseIndex = 0; caseIndex < 64; caseIndex++) {
			const drive = String.fromCharCode("A".charCodeAt(0) + randomInt(26));
			const rootSegments = Array.from(
				{ length: 1 + randomInt(4) },
				(_, segmentIndex) => `workspace-${caseIndex}-${segmentIndex}-${randomInt(36_000).toString(36)}`,
			);
			const root = `${drive}:\\${rootSegments.join("\\")}`;
			const child = `child-${randomInt(36_000).toString(36)}`;
			const file = `file-${randomInt(36_000).toString(36)}.txt`;
			const descendant = `${root}\\${child}\\${file}`;

			expect(isCanonicalWindowsPathWithin(root, root)).toBe(true);
			expect(isCanonicalWindowsPathWithin(root, descendant)).toBe(true);
			expect(isCanonicalWindowsPathWithin(root, `${root}\\unused\\..`)).toBe(true);

			const rawRoot = `${drive}:\\temporary-${caseIndex}\\..\\${rootSegments.join("\\")}`;
			const rawDescendant = `${rawRoot}\\${child}\\nested\\..\\${file}`;
			const normalizedDescendant = path.win32.resolve(rawDescendant);
			expect(path.win32.resolve(rawRoot)).toBe(root);
			expect(isCanonicalWindowsPathWithin(rawRoot, rawDescendant)).toBe(true);
			expect(isCanonicalWindowsPathWithin(root, normalizedDescendant)).toBe(true);

			const lowerDriveDescendant = `${drive.toLowerCase()}:\\${rootSegments.join("\\")}\\${child}\\${file}`;
			expect(isCanonicalWindowsPathWithin(root, lowerDriveDescendant)).toBe(true);

			const mutatedSegments = [...rootSegments];
			const mutatedAncestorIndex = randomInt(mutatedSegments.length);
			mutatedSegments[mutatedAncestorIndex] = mutatedSegments[mutatedAncestorIndex]!.replace(/[a-z]/, char =>
				char.toUpperCase(),
			);
			expect(isCanonicalWindowsPathWithin(root, `${drive}:\\${mutatedSegments.join("\\")}\\${file}`)).toBe(false);
			expect(isCanonicalWindowsPathWithin(root, `${root}Sibling\\${file}`)).toBe(false);

			const differentDrive = drive === "Z" ? "Y" : "Z";
			expect(isCanonicalWindowsPathWithin(root, `${differentDrive}:\\${rootSegments.join("\\")}\\${file}`)).toBe(
				false,
			);
			expect(
				isCanonicalWindowsPathWithin(
					root,
					`\\\\server-${caseIndex}\\share-${caseIndex}\\${rootSegments.join("\\")}\\${file}`,
				),
			).toBe(false);
		}
	});

	test("still reads a relative file and an absolute path inside cwd", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "inside.txt"), "INSIDE_OK");
		await fs.mkdir(path.join(cwd, "sub"));
		await Bun.write(path.join(cwd, "sub", "nested.txt"), "NESTED_OK");

		const relative = mentionText(await generateFileMentionMessages(["inside.txt"], cwd));
		expect(relative).toContain("INSIDE_OK");
		const absolute = mentionText(await generateFileMentionMessages([path.join(cwd, "inside.txt")], cwd));
		expect(absolute).toContain("INSIDE_OK");
		const stayedInside = mentionText(await generateFileMentionMessages(["sub/../sub/nested.txt"], cwd));
		expect(stayedInside).toContain("NESTED_OK");
	});

	const caseSensitiveDirectory = process.env.GJC_TEST_CASE_SENSITIVE_DIRECTORY;
	test.skipIf(process.platform !== "win32" || !caseSensitiveDirectory)(
		"does not auto-read a case-only sibling on a case-sensitive Windows directory",
		async () => {
			const root = caseSensitiveDirectory!;
			expect(directoryCaseSensitive(root)).toBe(true);
			const base = `gjc-file-mentions-${process.pid}-${Date.now()}`;
			const cwd = path.join(root, `${base}-Workspace`);
			const sibling = path.join(root, `${base}-workspace`);
			try {
				await fs.mkdir(cwd);
				await fs.mkdir(sibling);
				const secret = path.join(sibling, "secret.txt");
				await Bun.write(secret, "CASE_SENSITIVE_SIBLING_SECRET");
				expect(await fs.realpath(cwd)).not.toBe(await fs.realpath(sibling));

				const text = mentionText(await generateFileMentionMessages([secret], cwd));
				expect(text).not.toContain("CASE_SENSITIVE_SIBLING_SECRET");
			} finally {
				await fs.rm(cwd, { recursive: true, force: true });
				await fs.rm(sibling, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform !== "darwin")(
		"still reads an inside file through the macOS private alias",
		async () => {
			const cwd = await createTempDir();
			await Bun.write(path.join(cwd, "inside.txt"), "ALIAS_OK");
			const real = await fs.realpath(cwd);
			expect(real.startsWith("/private/")).toBe(true);
			const aliasFile = path.join(real.slice("/private".length), "inside.txt");
			expect(await fs.realpath(aliasFile)).toBe(path.join(real, "inside.txt"));
			const aliased = mentionText(await generateFileMentionMessages([aliasFile], cwd));
			expect(aliased).toContain("ALIAS_OK");
		},
	);

	test("does not auto-read a parent path, an absolute path, or a tilde path outside cwd", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "inside.txt"), "INSIDE_OK");
		const outsideDir = await createTempDir();
		const parentName = `up-${path.basename(cwd)}.txt`;
		const parentFile = path.join(path.dirname(cwd), parentName);
		const homeName = `.gjc-mention-${path.basename(cwd)}`;
		const homeFile = path.join(os.homedir(), homeName);
		await Bun.write(path.join(outsideDir, "abs.txt"), "ABS_SECRET");
		await Bun.write(parentFile, "PARENT_SECRET");
		await Bun.write(homeFile, "TILDE_SECRET");
		try {
			const messages = await generateFileMentionMessages(
				["inside.txt", path.join(outsideDir, "abs.txt"), `../${parentName}`, `~/${homeName}`],
				cwd,
			);
			const text = mentionText(messages);
			expect(text).toContain("INSIDE_OK");
			expect(text).not.toContain("ABS_SECRET");
			expect(text).not.toContain("PARENT_SECRET");
			expect(text).not.toContain("TILDE_SECRET");
			expect(
				messages
					.filter(message => message.role === "fileMention")
					.flatMap(message => (message.role === "fileMention" ? message.files.map(file => file.path) : [])),
			).toEqual(["inside.txt"]);
		} finally {
			await fs.rm(parentFile, { force: true });
			await fs.rm(homeFile, { force: true });
		}
	});

	test.skipIf(!canCreateSymlink)("does not follow a symlink that leaves cwd", async () => {
		const cwd = await createTempDir();
		const outsideDir = await createTempDir();
		const secret = path.join(outsideDir, "secret.txt");
		await Bun.write(secret, "LINK_SECRET");
		try {
			await fs.symlink(secret, path.join(cwd, "link.txt"));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPERM" || code === "EACCES") {
				throw new Error(`symlink creation failed with ${code}; the case should have been skipped`);
			}
			throw error;
		}
		const text = mentionText(await generateFileMentionMessages(["link.txt"], cwd));
		expect(text).not.toContain("LINK_SECRET");
	});
});
