import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	analyzeTestFile,
	DEFAULT_ALLOWLIST_PATH,
	type Finding,
	isIssueNumberedTestName,
	loadAllowlist,
	MAX_NEW_TEST_LINES,
	type TestFileChange,
} from "./check-test-slop";

const SCRIPT = path.join(import.meta.dir, "check-test-slop.ts");
const REPO_ROOT = path.join(import.meta.dir, "..");
const NONE = new Set<string>();

function added(file: string): TestFileChange {
	return { path: file, kind: "added", addedLines: new Set() };
}

function changed(file: string, lines: number[]): TestFileChange {
	return { path: file, kind: "changed", addedLines: new Set(lines) };
}

function rules(findings: Finding[]): string[] {
	return findings.map(finding => `${finding.severity}:${finding.rule}${finding.line === undefined ? "" : `@${finding.line}`}`);
}

const SOURCE_READ_TEST = [
	'import { expect, test } from "bun:test";',
	'import * as path from "node:path";',
	"",
	'test("reads source", async () => {',
	'\tconst text = await Bun.file(path.join(import.meta.dir, "../src/tools/read.ts")).text();',
	'\texpect(text).toContain("export");',
	"});",
	"",
].join("\n");

describe("rule 1: issue-numbered test names", () => {
	test("matches issue-NNN, gh-NNN and *-repro basenames case-insensitively", () => {
		expect(isIssueNumberedTestName("packages/a/test/issue-123-session.test.ts")).toBe(true);
		expect(isIssueNumberedTestName("packages/a/test/Issue_42.test.tsx")).toBe(true);
		expect(isIssueNumberedTestName("packages/a/test/gh-7.test.ts")).toBe(true);
		expect(isIssueNumberedTestName("packages/a/test/repro-issue-1020-shutdown.test.ts")).toBe(true);
		expect(isIssueNumberedTestName("packages/a/test/stale-title-REPRO.test.ts")).toBe(true);
	});

	test("does not match behavior names that merely contain the words", () => {
		expect(isIssueNumberedTestName("packages/a/test/tissue-12.test.ts")).toBe(false);
		expect(isIssueNumberedTestName("packages/a/test/github-auth.test.ts")).toBe(false);
		expect(isIssueNumberedTestName("packages/a/test/reproducible-build.test.ts")).toBe(false);
		expect(isIssueNumberedTestName("packages/issue-9/test/session.test.ts")).toBe(false);
	});

	test("fails an added issue-numbered file but not a changed or renamed one", () => {
		const body = 'import { expect, test } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n';
		expect(rules(analyzeTestFile(added("test/issue-55-crash.test.ts"), body, NONE))).toEqual(["error:issue-numbered-name"]);
		expect(rules(analyzeTestFile(changed("test/issue-55-crash.test.ts", [2]), body, NONE))).toEqual([]);
	});
});

describe("rule 2: source-text assertions", () => {
	test("fails a new test that reads a repo src file and asserts on its text", () => {
		const findings = analyzeTestFile(added("packages/a/test/read.test.ts"), SOURCE_READ_TEST, NONE);
		expect(rules(findings)).toEqual(["error:source-text-assertion@5"]);
		expect(findings[0].message).toContain("../src/tools/read.ts");
	});

	test("follows const indirection and readFileSync with segment joins", () => {
		const body = [
			'import { readFileSync } from "node:fs";',
			'import { join } from "node:path";',
			'const ROUTER = join(import.meta.dir, "..", "src", "router.tsx");',
			'const text = readFileSync(ROUTER, "utf8");',
			'expect(text).toContain("router");',
		].join("\n");
		expect(rules(analyzeTestFile(added("test/router.test.ts"), body, NONE))).toEqual(["error:source-text-assertion@4"]);
	});

	test("ignores temp-dir reads, existence probes, non-source files, and calls inside strings or comments", () => {
		const body = [
			'const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "x-"));',
			"const cwd = initRepo();",
			'expect(await Bun.file(path.join(tempDir, "src/a.ts")).text()).toBe("");',
			'expect(await Bun.file(path.join(cwd, "src/product.ts")).text()).toBe("");',
			'expect(await Bun.file(path.join(import.meta.dir, "../src/a.ts")).exists()).toBe(true);',
			'expect(await Bun.file(path.join(import.meta.dir, "../src/manifest.generated.json")).text()).toBe("");',
			'const culprit = "readFile(packages/coding-agent/src/tools/read.ts)";',
			'// readFileSync(path.join(import.meta.dir, "../src/a.ts"))',
			"expect(culprit).toBeDefined();",
		].join("\n");
		expect(rules(analyzeTestFile(added("test/fixtures.test.ts"), body, NONE))).toEqual([]);
	});

	test("does not fire without an assertion in the file", () => {
		const body = 'const text = await Bun.file(path.join(import.meta.dir, "../src/a.ts")).text();\nconsole.log(text);\n';
		expect(rules(analyzeTestFile(added("test/no-assert.test.ts"), body, NONE))).toEqual([]);
	});

	test("an allow-listed file is exempt", () => {
		const file = "packages/a/test/read.test.ts";
		expect(rules(analyzeTestFile(added(file), SOURCE_READ_TEST, new Set([file])))).toEqual([]);
	});

	test("a changed file is flagged only when the diff adds the read", () => {
		const file = "packages/a/test/read.test.ts";
		// Pre-existing read on line 5; the diff only touches line 6.
		expect(rules(analyzeTestFile(changed(file, [6]), SOURCE_READ_TEST, NONE))).toEqual([]);
		expect(rules(analyzeTestFile(changed(file, [5]), SOURCE_READ_TEST, NONE))).toEqual(["error:source-text-assertion@5"]);
	});

	test("every reviewed allow-list entry exists and still needs its exemption", async () => {
		const allowlist = await loadAllowlist(DEFAULT_ALLOWLIST_PATH);
		expect(allowlist.size).toBeGreaterThan(0);
		for (const file of allowlist) {
			const source = await Bun.file(path.join(REPO_ROOT, file)).text();
			const withoutExemption = analyzeTestFile(added(file), source, NONE).filter(
				finding => finding.rule === "source-text-assertion",
			);
			expect(withoutExemption.length, `${file} no longer reads source text; drop its allow-list entry`).toBeGreaterThan(0);
			const exempt = analyzeTestFile(added(file), source, allowlist).filter(finding => finding.rule === "source-text-assertion");
			expect(exempt).toEqual([]);
		}
	});
});

describe("rule 3: warn-only judgment calls", () => {
	test(`warns on a new test file over ${MAX_NEW_TEST_LINES} lines, not on one at the limit or a changed file`, () => {
		const lines = (count: number) => `${Array.from({ length: count }, (_, i) => `// ${i}`).join("\n")}\n`;
		expect(rules(analyzeTestFile(added("test/big.test.ts"), lines(MAX_NEW_TEST_LINES + 1), NONE))).toEqual([
			"warning:large-new-file",
		]);
		expect(rules(analyzeTestFile(added("test/big.test.ts"), lines(MAX_NEW_TEST_LINES), NONE))).toEqual([]);
		expect(rules(analyzeTestFile(changed("test/big.test.ts", [1]), lines(MAX_NEW_TEST_LINES + 1), NONE))).toEqual([]);
	});

	test("warns on sleeps over 100 ms in every supported form", () => {
		const body = [
			"await Bun.sleep(250);",
			"await sleep(1_000);",
			"setTimeout(() => {",
			"\tdone();",
			"}, 500);",
			"await setTimeout(150);",
			"await Bun.sleep(100);",
			"setTimeout(done, 50);",
			"await Bun.sleep(delayMs);",
			"await client.sleep(5000);",
		].join("\n");
		expect(rules(analyzeTestFile(added("test/timing.test.ts"), body, NONE))).toEqual([
			"warning:long-sleep@1",
			"warning:long-sleep@2",
			"warning:long-sleep@3",
			"warning:long-sleep@6",
		]);
	});

	test("in a changed file only added sleeps warn", () => {
		const body = "await Bun.sleep(500);\nawait Bun.sleep(600);\n";
		expect(rules(analyzeTestFile(changed("test/timing.test.ts", [2]), body, NONE))).toEqual(["warning:long-sleep@2"]);
	});
});

describe("check-test-slop CLI against a git range", () => {
	let repo: string;
	let allowlistPath: string;

	async function commitAll(message: string): Promise<void> {
		await $`git add -A`.cwd(repo).quiet();
		await $`git commit -q -m ${message}`.cwd(repo).quiet();
	}

	async function write(file: string, content: string): Promise<void> {
		await Bun.write(path.join(repo, file), content);
	}

	async function run(...args: string[]): Promise<{ exitCode: number; output: string }> {
		const result = await $`bun ${SCRIPT} --base main --allowlist ${allowlistPath} ${args}`.cwd(repo).quiet().nothrow();
		return { exitCode: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
	}

	async function branch(name: string): Promise<void> {
		await $`git checkout -q -B ${name} main`.cwd(repo).quiet();
	}

	beforeAll(async () => {
		repo = await fs.mkdtemp(path.join(os.tmpdir(), "check-test-slop-"));
		allowlistPath = path.join(repo, "..", `${path.basename(repo)}-allowlist.json`);
		await Bun.write(allowlistPath, JSON.stringify({ sourceTextReads: [] }));
		await $`git init -q -b main`.cwd(repo).quiet();
		await $`git config user.email t@example.com`.cwd(repo).quiet();
		await $`git config user.name test`.cwd(repo).quiet();
		await $`git config commit.gpgsign false`.cwd(repo).quiet();
		await write("pkg/src/tools/read.ts", "export const read = 1;\n");
		await write("pkg/test/issue-1-legacy.test.ts", SOURCE_READ_TEST);
		await write("pkg/test/reader.test.ts", 'import { expect, test } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n');
		await commitAll("base");
	});

	afterAll(async () => {
		await fs.rm(repo, { recursive: true, force: true });
		await fs.rm(allowlistPath, { force: true });
	});

	test("passes a clean range and ignores the existing backlog", async () => {
		await branch("clean");
		await write("pkg/test/reader.test.ts", 'import { expect, test } from "bun:test";\ntest("y", () => expect(2).toBe(2));\n');
		await commitAll("touch reader");
		const result = await run();
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("1 test file(s) inspected (0 added, 1 changed)");
		expect(result.output).toContain("0 error(s), 0 warning(s)");
	});

	test("fails an added issue-numbered test file", async () => {
		await branch("added-issue");
		await write("pkg/test/gh-77-repro.test.ts", 'test("x", () => {});\n');
		await commitAll("add repro");
		const result = await run();
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("::error file=pkg/test/gh-77-repro.test.ts::[test-slop/issue-numbered-name]");
	});

	test("does not fail a rename of an old issue-numbered file", async () => {
		await branch("rename-issue");
		await $`git mv pkg/test/issue-1-legacy.test.ts pkg/test/issue-1-legacy-moved.test.ts`.cwd(repo).quiet();
		await commitAll("rename legacy");
		const result = await run();
		expect(result.output).toContain("1 test file(s) inspected (0 added, 1 changed)");
		expect(result.exitCode).toBe(0);
	});

	test("fails a changed file only when the diff adds a source read", async () => {
		await branch("legacy-untouched-read");
		await write("pkg/test/issue-1-legacy.test.ts", `${SOURCE_READ_TEST}// unrelated edit\n`);
		await commitAll("edit legacy");
		const clean = await run();
		expect(clean.exitCode).toBe(0);

		await branch("adds-read");
		await write(
			"pkg/test/reader.test.ts",
			[
				'import { expect, test } from "bun:test";',
				'test("x", async () => {',
				'\tconst text = await Bun.file(new URL("../src/tools/read.ts", import.meta.url)).text();',
				"\texpect(text).toContain(\"read\");",
				"});",
				"",
			].join("\n"),
		);
		await commitAll("add source read");
		const failing = await run();
		expect(failing.exitCode).toBe(1);
		expect(failing.output).toContain("::error file=pkg/test/reader.test.ts,line=3::[test-slop/source-text-assertion]");

		await Bun.write(allowlistPath, JSON.stringify({ sourceTextReads: [{ path: "pkg/test/reader.test.ts", reason: "reviewed" }] }));
		try {
			expect((await run()).exitCode).toBe(0);
		} finally {
			await Bun.write(allowlistPath, JSON.stringify({ sourceTextReads: [] }));
		}
	});

	test("warnings annotate but exit 0", async () => {
		await branch("warn-only");
		const filler = Array.from({ length: MAX_NEW_TEST_LINES }, (_, i) => `// ${i}`).join("\n");
		await write("pkg/test/timing.test.ts", `await Bun.sleep(500);\n${filler}\n`);
		await commitAll("add slow test");
		const result = await run();
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("::warning file=pkg/test/timing.test.ts::[test-slop/large-new-file]");
		expect(result.output).toContain("::warning file=pkg/test/timing.test.ts,line=1::[test-slop/long-sleep]");
		expect(result.output).toContain("0 error(s), 2 warning(s)");
	});

	test("compares against the merge base, not the moving base tip", async () => {
		await branch("feature-before-base-moved");
		await write("pkg/test/feature.test.ts", 'test("x", () => {});\n');
		await commitAll("feature");
		await $`git checkout -q main`.cwd(repo).quiet();
		await write("pkg/test/issue-2-landed-on-main.test.ts", 'test("x", () => {});\n');
		await commitAll("main moves on");
		await $`git checkout -q feature-before-base-moved`.cwd(repo).quiet();
		const result = await run();
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("1 test file(s) inspected (1 added, 0 changed)");
	});
});
