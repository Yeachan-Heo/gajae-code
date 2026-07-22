import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	executeShell,
	FileType,
	fuzzyFind,
	type GlobMatch,
	GrepOutputMode,
	glob,
	grep,
	htmlToMarkdown,
	initNativeCrashDiagnostics,
	invalidateFsScanCache,
	listWorkspace,
	MacOSPowerAssertion,
	Process,
	ProcessStatus,
	PtySession,
	summarizeCode,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../native/index.js";

let testDir: string;

async function setupFixtures() {
	testDir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-test-"));

	await fs.writeFile(
		path.join(testDir, "file1.ts"),
		`export function hello() {
    // TODO: implement
    return "hello";
}
`,
	);

	await fs.writeFile(
		path.join(testDir, "file2.ts"),
		`export function world() {
    // FIXME: fix this
    return "world";
}
`,
	);

	await fs.writeFile(
		path.join(testDir, "readme.md"),
		`# Test README

This is a test file.
`,
	);

	await fs.writeFile(path.join(testDir, "history-search.ts"), "export const historySearch = true;\n");
}

async function cleanupFixtures() {
	await fs.rm(testDir, { recursive: true, force: true });
}

function canCreateFifo() {
	return process.platform !== "win32" && Boolean(Bun.which("mkfifo"));
}

async function createFifo(fifoPath: string) {
	const process = Bun.spawn(["mkfifo", fifoPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await process.exited;
	if (exitCode === 0) {
		return;
	}

	throw new Error(await new Response(process.stderr).text());
}

describe("pi-natives", () => {
	beforeAll(async () => {
		await setupFixtures();
		return async () => {
			await cleanupFixtures();
		};
	});

	it("keeps native crash diagnostics opt-in", () => {
		delete process.env.GJC_NATIVE_CRASH_DIAGNOSTICS;
		expect(initNativeCrashDiagnostics()).toBe(false);
	});

	it("signals only the pinned root process", async () => {
		if (process.platform === "darwin") return;

		const childPidPath = path.join(testDir, `signal-root-child-${crypto.randomUUID()}.pid`);
		const childProgram = "setInterval(() => {}, 1_000);";
		const rootProgram = `
			const fs = require("node:fs");
			const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(childProgram)}], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
			fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
			setInterval(() => {}, 1_000);
		`;
		const root = Bun.spawn([process.execPath, "-e", rootProgram], { stdio: ["ignore", "ignore", "ignore"] });
		let childPid: number | undefined;
		try {
			for (let attempt = 0; attempt < 100 && childPid === undefined; attempt++) {
				const marker = Bun.file(childPidPath);
				if (!(await marker.exists())) {
					await Bun.sleep(10);
					continue;
				}
				const pid = Number.parseInt(await marker.text(), 10);
				if (Number.isSafeInteger(pid) && pid > 0) childPid = pid;
				else await Bun.sleep(10);
			}
			expect(childPid).toBeDefined();
			if (childPid === undefined) return;

			const rootReference = Process.fromPid(root.pid);
			expect(rootReference).not.toBeNull();
			expect(rootReference?.signalRoot(os.constants.signals.SIGTERM)).toBe(true);
			await root.exited;

			const childReference = Process.fromPid(childPid);
			expect(childReference).not.toBeNull();
			expect(childReference?.signalRoot(os.constants.signals.SIGKILL)).toBe(true);
			expect(await childReference?.waitForExit({ timeoutMs: 2_000 })).toBe(true);
			expect(childReference?.status()).toBe(ProcessStatus.Exited);
		} finally {
			if (childPid) Process.fromPid(childPid)?.signalRoot(os.constants.signals.SIGKILL);
			Process.fromPid(root.pid)?.signalRoot(os.constants.signals.SIGKILL);
			await fs.rm(childPidPath, { force: true });
		}
	});

	describe("summarize", () => {
		it("summarizes TypeScript function bodies", () => {
			const result = summarizeCode({
				path: "fixture.ts",
				code: "export function greet(name: string): string {\n\tconst clean = name.trim();\n\tconst label = clean || 'world';\n\treturn label.toUpperCase();\n}\n",
			});

			expect(result.parsed).toBe(true);
			expect(result.elided).toBe(true);
			expect(result.segments.map(segment => segment.kind)).toEqual(["kept", "elided", "kept"]);
			expect(result.segments[0].text).toBe("export function greet(name: string): string {");
			expect(result.segments[1].startLine).toBe(2);
			expect(result.segments[1].endLine).toBe(4);
			expect(result.segments[2].text).toBe("}");
		});

		it("summarizes Rust and Python bodies while preserving boundary lines", () => {
			const rust = summarizeCode({
				path: "fixture.rs",
				code: 'impl Greeter {\n\tfn greet(&self) -> String {\n\t\tlet name = "world";\n\t\tlet label = name.to_uppercase();\n\t\tformat!("hello {label}")\n\t}\n}\n',
			});
			const python = summarizeCode({
				path: "fixture.py",
				code: "class Greeter:\n    def greet(self, name: str) -> str:\n        clean = name.strip()\n        label = clean or 'world'\n        return f'hello {label}'\n",
			});

			expect(rust.elided).toBe(true);
			expect(rust.segments.map(segment => segment.text ?? "...").join("\n")).toContain("impl Greeter {\n...\n}");
			expect(python.elided).toBe(true);
			expect(python.segments[0].text).toContain("def greet");
			expect(python.segments.at(-1)?.text).toContain("return");
		});

		it("summarizes multiline literals and block comments", () => {
			const result = summarizeCode({
				path: "fixture.ts",
				code: "/*\n * line 1\n * line 2\n * line 3\n * line 4\n */\nexport const config = {\n\ta: 1,\n\tb: 2,\n\tc: 3,\n};\n",
			});

			expect(result.elided).toBe(true);
			expect(result.segments.filter(segment => segment.kind === "elided")).toHaveLength(2);
			expect(result.segments.map(segment => segment.text ?? "...").join("\n")).toContain("...\n */");
			expect(result.segments.map(segment => segment.text ?? "...").join("\n")).toContain(
				"export const config = {\n...\n};",
			);
		});

		it("falls back for unsupported or empty input", () => {
			const unsupported = summarizeCode({ path: "fixture.txt", code: "plain text\nwith lines\n" });
			const empty = summarizeCode({ path: "fixture.ts", code: "" });

			expect(unsupported.parsed).toBe(false);
			expect(unsupported.segments).toHaveLength(1);
			expect(unsupported.segments[0].text).toBe("plain text\nwith lines\n");
			expect(empty.parsed).toBe(false);
			expect(empty.segments).toHaveLength(0);
		});

		it("respects minBodyLines", () => {
			const code = "function small() {\n\treturn 1;\n}\n";
			expect(summarizeCode({ path: "fixture.ts", code }).elided).toBe(false);
			expect(summarizeCode({ path: "fixture.ts", code, minBodyLines: 3 }).elided).toBe(true);
		});
	});
	describe("grep", () => {
		it("should find patterns in files", async () => {
			const result = await grep({
				pattern: "TODO",
				path: testDir,
			});

			expect(result.totalMatches).toBe(1);
			expect(result.matches.length).toBe(1);
			expect(result.matches[0].line).toContain("TODO");
		});

		it("should handle literal function-call text with parentheses", async () => {
			const result = await grep({
				pattern: "hello(",
				path: testDir,
			});

			expect(result.totalMatches).toBe(1);
			expect(result.matches).toHaveLength(1);
			expect(result.matches[0].line).toContain("hello()");
		});

		it("should respect glob patterns", async () => {
			const result = await grep({
				pattern: "test",
				path: testDir,
				glob: "*.md",
				ignoreCase: true,
			});

			expect(result.totalMatches).toBe(2); // "Test" in title + "test" in body
		});

		it("should return filesWithMatches mode", async () => {
			const result = await grep({
				pattern: "return",
				path: testDir,
				mode: GrepOutputMode.FilesWithMatches,
			});

			expect(result.filesWithMatches).toBeGreaterThan(0);
		});

		it("counts files instead of line matches in filesWithMatches mode", async () => {
			const scopedDir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-grep-files-"));
			try {
				await fs.writeFile(path.join(scopedDir, "one.ts"), "return 1;\nreturn 2;\n");
				await fs.writeFile(path.join(scopedDir, "two.ts"), "return 3;\n");

				const result = await grep({
					pattern: "return",
					path: scopedDir,
					mode: GrepOutputMode.FilesWithMatches,
				});

				expect(result.totalMatches).toBe(2);
				expect(result.filesWithMatches).toBe(2);
				expect(result.matches.map(match => path.basename(match.path)).sort()).toEqual(["one.ts", "two.ts"]);
			} finally {
				await fs.rm(scopedDir, { recursive: true, force: true });
			}
		});

		it("should treat unknown grep type filter as a strict extension filter", async () => {
			const result = await grep({
				pattern: "return",
				path: testDir,
				type: "definitelynotatype",
			});

			expect(result.totalMatches).toBe(0);
			expect(result.filesWithMatches).toBe(0);
		});

		it("should respect .gitignore by default and allow opting out", async () => {
			const scopedDir = path.join(testDir, "grep-gitignore-case");
			await fs.mkdir(scopedDir, { recursive: true });
			await fs.mkdir(path.join(scopedDir, ".git"), { recursive: true });
			await fs.writeFile(path.join(scopedDir, ".gitignore"), "ignored.ts\n");
			await fs.writeFile(path.join(scopedDir, "ignored.ts"), 'export const ignoredToken = "IGNORE_ME_TOKEN";\n');

			const defaultResult = await grep({
				pattern: "IGNORE_ME_TOKEN",
				path: scopedDir,
			});

			expect(defaultResult.totalMatches).toBe(0);
			expect(defaultResult.filesWithMatches).toBe(0);

			const includeIgnoredResult = await grep({
				pattern: "IGNORE_ME_TOKEN",
				path: scopedDir,
				gitignore: false,
			});

			expect(includeIgnoredResult.totalMatches).toBe(1);
			expect(includeIgnoredResult.matches.some(match => match.path.endsWith("ignored.ts"))).toBe(true);
		});

		it("should keep hidden filtering when gitignore is disabled", async () => {
			const scopedDir = path.join(testDir, "grep-hidden-gitignore-case");
			await fs.mkdir(scopedDir, { recursive: true });
			await fs.mkdir(path.join(scopedDir, ".git"), { recursive: true });
			await fs.writeFile(path.join(scopedDir, ".gitignore"), ".hidden-ignored.ts\n");
			await fs.writeFile(
				path.join(scopedDir, ".hidden-ignored.ts"),
				'export const hiddenIgnoredToken = "HIDDEN_IGNORE_TOKEN";\n',
			);

			const hiddenExcluded = await grep({
				pattern: "HIDDEN_IGNORE_TOKEN",
				path: scopedDir,
				gitignore: false,
				hidden: false,
			});

			expect(hiddenExcluded.totalMatches).toBe(0);

			const hiddenIncluded = await grep({
				pattern: "HIDDEN_IGNORE_TOKEN",
				path: scopedDir,
				gitignore: false,
				hidden: true,
			});

			expect(hiddenIncluded.totalMatches).toBe(1);
			expect(hiddenIncluded.matches.some(match => match.path.endsWith(".hidden-ignored.ts"))).toBe(true);
		});

		it("should skip FIFOs when searching a directory", async () => {
			if (!canCreateFifo()) {
				return;
			}

			const scopedDir = path.join(testDir, "grep-fifo-directory-case");
			const filePath = path.join(scopedDir, "match.txt");
			const fifoPath = path.join(scopedDir, "ignored.fifo");
			await fs.mkdir(scopedDir, { recursive: true });

			try {
				await fs.writeFile(filePath, "FIFO_TOKEN in regular file\n");
				await createFifo(fifoPath);

				const outcome = await Promise.race([
					grep({
						pattern: "FIFO_TOKEN",
						path: scopedDir,
						gitignore: false,
					}).then(result => ({ kind: "done" as const, result })),
					Bun.sleep(2000).then(() => ({ kind: "timeout" as const })),
				]);

				expect(outcome.kind).toBe("done");
				if (outcome.kind !== "done") {
					return;
				}

				expect(outcome.result.totalMatches).toBe(1);
				expect(outcome.result.matches).toHaveLength(1);
				expect(outcome.result.matches[0].path.endsWith("match.txt")).toBe(true);
				expect(outcome.result.matches.some(match => match.path.endsWith("ignored.fifo"))).toBe(false);
			} finally {
				await fs.rm(scopedDir, { recursive: true, force: true });
			}
		});

		it("should return no matches for a FIFO path", async () => {
			if (!canCreateFifo()) {
				return;
			}

			const scopedDir = path.join(testDir, "grep-fifo-direct-path-case");
			const fifoPath = path.join(scopedDir, "direct.fifo");
			await fs.mkdir(scopedDir, { recursive: true });

			try {
				await createFifo(fifoPath);

				const outcome = await Promise.race([
					grep({
						pattern: "FIFO_TOKEN",
						path: fifoPath,
						gitignore: false,
					}).then(result => ({ kind: "done" as const, result })),
					Bun.sleep(2000).then(() => ({ kind: "timeout" as const })),
				]);

				expect(outcome.kind).toBe("done");
				if (outcome.kind !== "done") {
					return;
				}

				expect(outcome.result.totalMatches).toBe(0);
				expect(outcome.result.filesWithMatches).toBe(0);
				expect(outcome.result.matches).toHaveLength(0);
			} finally {
				await fs.rm(scopedDir, { recursive: true, force: true });
			}
		});
	});
	describe("fuzzyFind", () => {
		it("should match abbreviated fuzzy queries across separators", async () => {
			const result = await fuzzyFind({
				query: "histsr",
				path: testDir,
				hidden: true,
				gitignore: true,
				maxResults: 20,
			});

			expect(result.matches.some(match => match.path === "history-search.ts")).toBe(true);
		});
	});

	describe("find", () => {
		it("should find files matching pattern", async () => {
			const result = await glob({
				pattern: "*.ts",
				path: testDir,
			});

			expect(result.totalMatches).toBe(3);
			expect(result.matches.every((m: GlobMatch) => m.path.endsWith(".ts"))).toBe(true);
		});

		it("should filter by file type", async () => {
			const result = await glob({
				pattern: "*",
				path: testDir,
				fileType: FileType.File,
			});

			expect(result.totalMatches).toBe(4);
		});

		it("should invalidate scan cache when invalidateFsScanCache receives a relative path", async () => {
			await glob({ pattern: "*.ts", path: testDir, cache: true });
			const newFile = path.join(testDir, "newly-added.ts");
			await fs.writeFile(newFile, "export const newer = true;\n");

			const relativePath = path.relative(process.cwd(), newFile);
			invalidateFsScanCache(relativePath);

			const result = await glob({ pattern: "newly-added.ts", path: testDir, cache: true });
			expect(result.matches.some(match => match.path === "newly-added.ts")).toBe(true);
		});

		it("should avoid scan work when maxResults is zero", async () => {
			const result = await glob({
				pattern: "**/*",
				path: testDir,
				maxResults: 0,
			});

			expect(result.totalMatches).toBe(0);
			expect(result.matches).toHaveLength(0);
		});

		it("should fast-recheck empty cached results when threshold is reached", async () => {
			const fileName = "cache-empty-recheck-target.txt";
			const filePath = path.join(testDir, fileName);
			await fs.rm(filePath, { force: true });
			invalidateFsScanCache();
			const first = await glob({ pattern: fileName, path: testDir, hidden: true, gitignore: true, cache: true });
			expect(first.totalMatches).toBe(0);
			await fs.writeFile(filePath, "created after empty cached query\n");
			await Bun.sleep(250);
			const second = await glob({ pattern: fileName, path: testDir, hidden: true, gitignore: true, cache: true });
			expect(second.totalMatches).toBe(1);
		});
	});

	describe("listWorkspace", () => {
		it("returns tree entries and gitignored AGENTS.md files outside ignored directories", async () => {
			const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-workspace-"));
			try {
				await fs.writeFile(path.join(workspaceDir, ".gitignore"), "ignored.txt\nsrc/AGENTS.md\nignored-dir/\n");
				await fs.writeFile(path.join(workspaceDir, "kept.ts"), "export const kept = true;\n");
				await fs.writeFile(path.join(workspaceDir, "ignored.txt"), "ignored\n");
				await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
				await fs.writeFile(path.join(workspaceDir, "src", "AGENTS.md"), "src rules\n");
				await fs.writeFile(path.join(workspaceDir, "src", "main.ts"), "export const main = true;\n");
				await fs.mkdir(path.join(workspaceDir, "ignored-dir"), { recursive: true });
				await fs.writeFile(path.join(workspaceDir, "ignored-dir", "AGENTS.md"), "ignored rules\n");

				const result = await listWorkspace({
					path: workspaceDir,
					maxDepth: 3,
					gitignore: true,
					hidden: false,
					collectAgentsMd: true,
				});
				const entryPaths = result.entries.map(entry => entry.path);

				expect(result.truncated).toBe(false);
				expect(entryPaths).toContain("kept.ts");
				expect(entryPaths).toContain("src");
				expect(entryPaths).toContain("src/AGENTS.md");
				expect(entryPaths).toContain("src/main.ts");
				expect(entryPaths).not.toContain("ignored.txt");
				expect(entryPaths).not.toContain("ignored-dir");
				expect(entryPaths).not.toContain("ignored-dir/AGENTS.md");
				expect(result.agentsMdFiles).toEqual(["src/AGENTS.md"]);
			} finally {
				await fs.rm(workspaceDir, { recursive: true, force: true });
			}
		});
	});

	describe("text tab width", () => {
		it("uses default tab width and supports explicit overrides", () => {
			expect(visibleWidth("a\tb", 3)).toBe(5);
			expect(visibleWidth("a\tb", 4)).toBe(6);
			expect(visibleWidth("a\tb", 2)).toBe(4);
		});

		it("applies explicit tab width in truncate and wrap", () => {
			expect(truncateToWidth("\tfoo", 6, undefined, false, 4)).toBe("\tf…");
			expect(wrapTextWithAnsi("\tfoo", 4, 4)).toEqual(["\t", "foo"]);
		});
	});

	describe("pty", () => {
		it("should time out detached background workloads without hanging", async () => {
			if (process.platform === "win32" || !Bun.which("bash")) {
				return;
			}

			const session = new PtySession();
			const started = Date.now();
			try {
				const outcome = await Promise.race([
					session
						.start(
							{
								command: 'bash -lc "set -m; sleep 30 & disown; sleep 30"',
								cwd: testDir,
								timeoutMs: 150,
								cols: 120,
								rows: 40,
							},
							undefined,
						)
						.then(result => ({ kind: "done" as const, result })),
					Bun.sleep(4000).then(() => ({ kind: "hang" as const })),
				]);

				expect(outcome.kind).toBe("done");
				if (outcome.kind !== "done") {
					return;
				}

				expect(outcome.result.timedOut).toBe(true);
				expect(Date.now() - started).toBeLessThan(4000);
			} finally {
				try {
					session.kill();
				} catch {}
			}
		});
	});

	describe("shell", () => {
		it("should time out background workloads without leaving delayed writers behind", async () => {
			if (process.platform === "win32") {
				return;
			}

			const markerPath = path.join(testDir, "shell-timeout-marker.txt");
			const markerEscaped = markerPath.replace(/'/g, "'\\''");
			await fs.rm(markerPath, { force: true });

			const result = await executeShell({
				command: `{ sleep 0.15; echo done > '${markerEscaped}'; } & sleep 10`,
				cwd: testDir,
				timeoutMs: 50,
			});

			expect(result.timedOut).toBe(true);

			await Bun.sleep(500);
			expect(await Bun.file(markerPath).exists()).toBe(false);
		});

		it("should SIGKILL workloads that ignore SIGTERM on timeout", async () => {
			if (process.platform === "win32") {
				return;
			}

			const markerPath = path.join(testDir, "shell-timeout-sigkill-marker.txt");
			const markerEscaped = markerPath.replace(/'/g, "'\\''");
			await fs.rm(markerPath, { force: true });

			const result = await executeShell({
				command: `trap '' TERM; sleep 0.3; echo done > '${markerEscaped}'`,
				cwd: testDir,
				timeoutMs: 50,
			});

			expect(result.timedOut).toBe(true);

			await Bun.sleep(600);
			expect(await Bun.file(markerPath).exists()).toBe(false);
		});
	});
	describe("htmlToMarkdown", () => {
		it("should convert basic HTML to markdown", async () => {
			const html = "<h1>Hello World</h1><p>This is a paragraph.</p>";
			const markdown = await htmlToMarkdown(html);

			expect(markdown).toContain("# Hello World");
			expect(markdown).toContain("This is a paragraph.");
		});

		it("should handle links", async () => {
			const html = '<p>Visit <a href="https://example.com">Example</a> for more info.</p>';
			const markdown = await htmlToMarkdown(html);

			expect(markdown).toContain("[Example](https://example.com)");
		});

		it("should handle lists", async () => {
			const html = "<ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>";
			const markdown = await htmlToMarkdown(html);

			expect(markdown).toContain("- Item 1");
			expect(markdown).toContain("- Item 2");
			expect(markdown).toContain("- Item 3");
		});

		it("should handle code blocks", async () => {
			const html = "<pre><code>const x = 42;</code></pre>";
			const markdown = await htmlToMarkdown(html);

			expect(markdown).toContain("const x = 42;");
		});

		it("should skip images when option is set", async () => {
			const html = '<p>Text with <img src="image.jpg" alt="pic"> image</p>';
			const withImages = await htmlToMarkdown(html);
			const withoutImages = await htmlToMarkdown(html, { skipImages: true });

			expect(withImages).toContain("pic");
			expect(withoutImages).not.toContain("pic");
		});

		it("should clean content when option is set", async () => {
			const html = "<nav>Navigation</nav><main><p>Main content</p></main><footer>Footer</footer>";
			const cleaned = await htmlToMarkdown(html, { cleanContent: true });

			expect(cleaned).toContain("Main content");
			// Navigation/footer may or may not be removed depending on preprocessing
		});
	});

	describe("MacOSPowerAssertion", () => {
		it("should create a stoppable power assertion handle", () => {
			const assertion = MacOSPowerAssertion.start({ reason: "pi-natives test" });
			assertion.stop();
			assertion.stop();
		});
	});
});
