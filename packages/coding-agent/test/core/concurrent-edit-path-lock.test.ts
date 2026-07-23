/**
 * Regression for https://github.com/Yeachan-Heo/gajae-code/issues/2900
 *
 * Concurrent disjoint applyPatch calls must not silently drop a successful edit.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyPatch, type FileSystem } from "../../src/edit/modes/patch";
import { withEditPathMutation } from "../../src/edit/path-mutation-lock";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fsp.rm(directory, { recursive: true, force: true })),
	);
});

function memoryFs(initial: string): { text: string; fs: FileSystem } {
	const state = { text: initial };
	return {
		get text() {
			return state.text;
		},
		set text(value: string) {
			state.text = value;
		},
		fs: {
			exists: async () => true,
			read: async () => state.text,
			write: async (_p, content) => {
				await Bun.sleep(10);
				state.text = content;
			},
			delete: async () => {
				state.text = "";
			},
			mkdir: async () => {},
		},
	};
}

describe("concurrent path mutation (#2900)", () => {
	it("keeps both disjoint concurrent applyPatch results under injectible fs", async () => {
		const store = memoryFs("a\nb\nc\n");
		const results = await Promise.all([
			applyPatch(
				{ path: "x", op: "update", diff: "@@\n-a\n+A" },
				{ cwd: ".", fs: store.fs, allowFuzzy: false, crossProcessLock: false },
			),
			applyPatch(
				{ path: "x", op: "update", diff: "@@\n-c\n+C" },
				{ cwd: ".", fs: store.fs, allowFuzzy: false, crossProcessLock: false },
			),
		]);

		expect(store.text.includes("A")).toBe(true);
		expect(store.text.includes("C")).toBe(true);
		expect(store.text).toBe("A\nb\nC\n");
		// Both calls report success; order may vary but neither is a silent loss.
		expect(results).toHaveLength(2);
		expect(results.every(result => result.change.type === "update")).toBe(true);
	});

	it("rejects a write when content changed after the locked read (CAS)", async () => {
		// Force a mid-flight mutation between the first read and the commit-time CAS read:
		// first read returns original; commit re-read returns different content.
		let phase: "patch" | "cas" = "patch";
		const racingFs: FileSystem = {
			exists: async () => true,
			read: async () => {
				if (phase === "patch") {
					phase = "cas";
					return "a\nb\nc\n";
				}
				return "other\nb\nc\n";
			},
			write: async () => {
				throw new Error("write must not run on conflict");
			},
			delete: async () => {},
			mkdir: async () => {},
		};

		await expect(
			applyPatch(
				{ path: "x", op: "update", diff: "@@\n-a\n+A" },
				{ cwd: ".", fs: racingFs, allowFuzzy: false, crossProcessLock: false },
			),
		).rejects.toThrow(/concurrent edit conflict/);
	});

	it("serializes real-filesystem concurrent writes so both disjoint edits survive", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-concurrent-edit-"));
		temporaryDirectories.push(root);
		const filePath = path.join(root, "file.txt");
		await fsp.writeFile(filePath, "a\nb\nc\n", "utf8");

		await Promise.all([
			applyPatch({ path: filePath, op: "update", diff: "@@\n-a\n+A" }, { cwd: root, allowFuzzy: false }),
			applyPatch({ path: filePath, op: "update", diff: "@@\n-c\n+C" }, { cwd: root, allowFuzzy: false }),
		]);

		const text = await fsp.readFile(filePath, "utf8");
		expect(text.includes("A")).toBe(true);
		expect(text.includes("C")).toBe(true);
		expect(text).toBe("A\nb\nC\n");
	});

	it("withEditPathMutation runs critical sections for one path strictly one-at-a-time", async () => {
		const events: string[] = [];
		await Promise.all([
			withEditPathMutation(
				["/tmp/gjc-edit-lock-a"],
				async () => {
					events.push("a-start");
					await Bun.sleep(20);
					events.push("a-end");
				},
				{ crossProcess: false },
			),
			withEditPathMutation(
				["/tmp/gjc-edit-lock-a"],
				async () => {
					events.push("b-start");
					await Bun.sleep(5);
					events.push("b-end");
				},
				{ crossProcess: false },
			),
		]);
		// Full mutual exclusion: no interleaving of start/end pairs (order of a/b is race-dependent).
		const joined = events.join(",");
		expect(joined === "a-start,a-end,b-start,b-end" || joined === "b-start,b-end,a-start,a-end").toBe(true);
	});
});
