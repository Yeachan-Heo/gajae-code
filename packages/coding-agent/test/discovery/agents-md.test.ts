import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@gajae-code/coding-agent/capability/types";
import { type AgentsMdReader, loadAgentsMd } from "@gajae-code/coding-agent/discovery/agents-md";

const MAX_FILE_BYTES = 64 * 1024;

function context(cwd: string, repoRoot: string): LoadContext {
	return { cwd, home: path.dirname(repoRoot), repoRoot };
}

describe("AGENTS.md discovery bounds", () => {
	test("limits ancestor candidates to 32 directories and passes the per-file byte limit to its reader", async () => {
		const root = path.join(path.sep, "repo");
		const cwd = path.join(root, ...Array.from({ length: 32 }, (_value, index) => `level-${index}`));
		const calls: string[] = [];
		const reader: AgentsMdReader = async (filePath, maxBytes) => {
			calls.push(filePath);
			expect(maxBytes).toBe(MAX_FILE_BYTES);
			return { content: null, byteLength: 0, tooLarge: false };
		};

		const result = await loadAgentsMd(context(cwd, root), reader);

		expect(calls).toHaveLength(32);
		expect(result.warnings).toEqual(["AGENTS.md discovery stopped after scanning 32 ancestor directories."]);
	});

	test("uses raw byte counts without warning for nonexistent ancestors beyond a full aggregate budget", async () => {
		const root = path.join(path.sep, "repo");
		const cwd = path.join(root, "one", "two", "three", "four");
		const requestedBytes: number[] = [];
		const reader: AgentsMdReader = async (filePath, maxBytes) => {
			requestedBytes.push(maxBytes);
			if (path.dirname(filePath) === root) return { content: null, byteLength: 0, tooLarge: false };
			return {
				content: path.basename(path.dirname(filePath)),
				byteLength: MAX_FILE_BYTES,
				tooLarge: false,
			};
		};

		const result = await loadAgentsMd(context(cwd, root), reader);

		expect(result.items.map(item => item.content)).toEqual(["four", "three", "two", "one"]);
		expect(requestedBytes).toEqual([MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES, 0]);
		expect(result.warnings).toEqual([]);
	});

	test("warns when an existing ancestor is omitted after the aggregate budget is full", async () => {
		const root = path.join(path.sep, "repo");
		const cwd = path.join(root, "one", "two", "three", "four");
		const requestedBytes: number[] = [];
		const reader: AgentsMdReader = async (filePath, maxBytes) => {
			requestedBytes.push(maxBytes);
			if (maxBytes === 0) return { content: null, byteLength: 1, tooLarge: true };
			return {
				content: path.basename(path.dirname(filePath)),
				byteLength: MAX_FILE_BYTES,
				tooLarge: false,
			};
		};

		const result = await loadAgentsMd(context(cwd, root), reader);

		expect(result.items.map(item => item.content)).toEqual(["four", "three", "two", "one"]);
		expect(requestedBytes).toEqual([MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES, 0]);
		expect(result.warnings).toEqual(["Skipped one or more AGENTS.md files that exceed the 256 KiB aggregate limit."]);
	});

	test("caps the final candidate read at the remaining aggregate bytes plus its sentinel", async () => {
		const root = path.join(path.sep, "repo");
		const cwd = path.join(root, "one", "two", "three", "four");
		const requestedBytes: number[] = [];
		const acceptedBytes = [MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES, 60 * 1024];
		const reader: AgentsMdReader = async (_filePath, maxBytes) => {
			requestedBytes.push(maxBytes);
			const byteLength = acceptedBytes.shift();
			if (byteLength !== undefined) return { content: "accepted", byteLength, tooLarge: false };
			return { content: null, byteLength: maxBytes + 1, tooLarge: true };
		};

		const result = await loadAgentsMd(context(cwd, root), reader);

		expect(requestedBytes).toEqual([MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES, 4 * 1024]);
		expect(result.items).toHaveLength(4);
		expect(result.warnings).toEqual(["Skipped one or more AGENTS.md files that exceed the 256 KiB aggregate limit."]);
	});

	test("omits an oversized candidate without including partial content", async () => {
		const root = path.join(path.sep, "repo");
		const cwd = path.join(root, "child");
		const reader: AgentsMdReader = async filePath =>
			filePath.startsWith(cwd)
				? { content: null, byteLength: MAX_FILE_BYTES + 1, tooLarge: true }
				: { content: "parent", byteLength: 6, tooLarge: false };

		const result = await loadAgentsMd(context(cwd, root), reader);

		expect(result.items.map(item => item.content)).toEqual(["parent"]);
		expect(result.warnings).toEqual(["Skipped one or more AGENTS.md files that exceed the 64 KiB limit."]);
	});
	test("reads only through the sentinel and still follows a regular-file symlink", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-agents-md-"));
		const target = path.join(tempDir, "target.md");
		const agentPath = path.join(tempDir, "AGENTS.md");
		try {
			fs.writeFileSync(target, "linked instructions");
			fs.symlinkSync(target, agentPath);
			await expect(loadAgentsMd(context(tempDir, tempDir))).resolves.toMatchObject({
				items: [{ content: "linked instructions" }],
				warnings: [],
			});

			fs.writeFileSync(agentPath, Buffer.alloc(MAX_FILE_BYTES + 1));
			await expect(loadAgentsMd(context(tempDir, tempDir))).resolves.toEqual({
				items: [],
				warnings: ["Skipped one or more AGENTS.md files that exceed the 64 KiB limit."],
			});
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	test.skipIf(process.platform === "win32")("rejects a hardlinked candidate in isolated-home mode", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-agents-md-hardlink-"));
		const home = path.join(tempDir, "home");
		const project = path.join(home, "project");
		const outside = path.join(tempDir, "outside.md");
		const candidate = path.join(project, "AGENTS.md");
		try {
			fs.mkdirSync(project, { recursive: true });
			fs.writeFileSync(outside, "outside instructions");
			fs.linkSync(outside, candidate);
			await expect(loadAgentsMd({ cwd: project, home, repoRoot: project, isolatedHome: true })).resolves.toEqual({
				items: [],
				warnings: [],
			});
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	test("ignores non-regular AGENTS.md candidates", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-agents-md-"));
		const agentPath = path.join(tempDir, "AGENTS.md");
		try {
			fs.mkdirSync(agentPath);
			await expect(loadAgentsMd(context(tempDir, tempDir))).resolves.toEqual({
				items: [],
				warnings: [],
			});
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	test.skipIf(process.platform === "win32")("rejects a FIFO candidate without blocking discovery", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-agents-md-"));
		const agentPath = path.join(tempDir, "AGENTS.md");
		const created = Bun.spawnSync(["mkfifo", agentPath]);
		expect(created.exitCode).toBe(0);
		const loadPromise = loadAgentsMd(context(tempDir, tempDir));
		try {
			await expect(
				Promise.race([
					loadPromise,
					Bun.sleep(500).then(() => {
						throw new Error("FIFO discovery blocked");
					}),
				]),
			).resolves.toEqual({ items: [], warnings: [] });
		} finally {
			try {
				const writer = fs.openSync(agentPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
				fs.closeSync(writer);
			} catch {
				// No pending reader remains after the non-blocking descriptor check.
			}
			await loadPromise.catch(() => {});
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	test.skipIf(process.platform === "win32")(
		"rejects a leaf symlink swap after explicit-home canonicalization",
		async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-agents-md-race-"));
			const home = path.join(tempDir, "home");
			const project = path.join(home, "project");
			const candidate = path.join(project, "AGENTS.md");
			const outside = path.join(tempDir, "outside.md");
			const backup = path.join(project, "AGENTS.safe.md");
			await fsPromises.mkdir(project, { recursive: true });
			await fsPromises.writeFile(candidate, "safe instructions");
			await fsPromises.writeFile(outside, "outside instructions");
			let swapped = false;
			const realOpen = fsPromises.open.bind(fsPromises);
			const openSpy = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
				const [filePath] = args;
				if (!swapped && String(filePath) === candidate) {
					swapped = true;
					await fsPromises.rename(candidate, backup);
					await fsPromises.symlink(outside, candidate);
				}
				return await realOpen(...args);
			});
			try {
				const result = await loadAgentsMd({ cwd: project, home, repoRoot: project, isolatedHome: true });
				expect(swapped).toBe(true);
				expect(result.items).toEqual([]);
			} finally {
				openSpy.mockRestore();
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);
});
