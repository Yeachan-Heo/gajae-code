import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NativeDurableReplaceResult } from "@gajae-code/natives";
import { replaceStagedPublication, type TelegramDaemonFs } from "../src/sdk/bus/telegram-daemon";

function nativeFs(): TelegramDaemonFs {
	return {
		mkdir: async (dir, opts) => {
			await fs.promises.mkdir(dir, opts);
		},
		readFile: (file, encoding) => fs.promises.readFile(file, encoding),
		writeFile: (file, data, opts) => fs.promises.writeFile(file, data, opts),
		rename: (from, to) => fs.promises.rename(from, to),
		unlink: file => fs.promises.unlink(file),
		open: async (file, flags, mode) => await fs.promises.open(file, flags, mode),
		readdir: dir => fs.promises.readdir(dir),
		chmod: (file, mode) => fs.promises.chmod(file, mode),
	};
}

async function stage(): Promise<{ dir: string; staged: string; destination: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-durable-replace-"));
	const staged = path.join(dir, "state.json.tmp");
	const destination = path.join(dir, "state.json");
	await fs.promises.writeFile(staged, '{"successor":true}\n');
	await fs.promises.writeFile(destination, '{"incumbent":true}\n');
	return { dir, staged, destination };
}

const committed: NativeDurableReplaceResult = {
	ok: true,
	mutationState: "committed",
	durabilityState: "durable",
	reason: "none",
	primitive: "move_file_ex_write_through",
	phase: "complete",
};

function notCommitted(code: string): NativeDurableReplaceResult {
	return {
		ok: false,
		code,
		mutationState: "not_committed",
		durabilityState: "not_attempted",
		reason: code,
		primitive: "move_file_ex_write_through",
		phase: "preflight",
	};
}

describe("telegram durable staged publication", () => {
	test("uses the native write-through replacement on Windows and does not also rename", async () => {
		const { dir, staged, destination } = await stage();
		try {
			const calls: Array<[string, string]> = [];
			let renamed = false;
			const fsImpl = {
				...nativeFs(),
				rename: async () => {
					renamed = true;
				},
			};
			await replaceStagedPublication(fsImpl, staged, destination, "win32", (source, target) => {
				calls.push([source, target]);
				// Emulate the native replacement so the destination reflects a real commit.
				fs.renameSync(source, target);
				return committed;
			});
			expect(calls).toEqual([[staged, destination]]);
			expect(renamed).toBe(false);
			expect(await fs.promises.readFile(destination, "utf8")).toBe('{"successor":true}\n');
			expect(fs.existsSync(staged)).toBe(false);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("does not consult the native replacement on non-Windows hosts", async () => {
		const { dir, staged, destination } = await stage();
		try {
			let consulted = false;
			await replaceStagedPublication(nativeFs(), staged, destination, "linux", () => {
				consulted = true;
				return committed;
			});
			expect(consulted).toBe(false);
			expect(await fs.promises.readFile(destination, "utf8")).toBe('{"successor":true}\n');
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("falls back to rename when the native binding is absent", async () => {
		const { dir, staged, destination } = await stage();
		try {
			await replaceStagedPublication(nativeFs(), staged, destination, "win32", undefined);
			expect(await fs.promises.readFile(destination, "utf8")).toBe('{"successor":true}\n');
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("falls back to rename when the native replacement throws or proves it did not commit", async () => {
		for (const durableReplace of [
			() => {
				throw new Error("addon missing");
			},
			() => notCommitted("unsupported_platform"),
		]) {
			const { dir, staged, destination } = await stage();
			try {
				await replaceStagedPublication(nativeFs(), staged, destination, "win32", durableReplace);
				expect(await fs.promises.readFile(destination, "utf8")).toBe('{"successor":true}\n');
			} finally {
				await fs.promises.rm(dir, { recursive: true, force: true });
			}
		}
	});

	test("refuses to fall back when the native outcome cannot prove the replacement did not land", async () => {
		const { dir, staged, destination } = await stage();
		try {
			let renamed = false;
			const fsImpl = {
				...nativeFs(),
				rename: async () => {
					renamed = true;
				},
			};
			await expect(
				replaceStagedPublication(fsImpl, staged, destination, "win32", () => ({
					ok: false,
					code: "move_file_ex_failed",
					osCode: 5,
					mutationState: "unknown",
					durabilityState: "not_provable",
					reason: "unknown",
					primitive: "move_file_ex_write_through",
					phase: "replace",
				})),
			).rejects.toThrow(/did not commit: move_file_ex_failed \(unknown\)/);
			// A fallback rename here could resurrect the staged file over a newer
			// successor installed by whoever actually completed the replacement.
			expect(renamed).toBe(false);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});
