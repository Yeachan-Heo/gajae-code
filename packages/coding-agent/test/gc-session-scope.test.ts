import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectSessionScopeUsage,
	type GcSessionScopeUsage,
	shouldReportSessionScope,
} from "../src/gjc-runtime/gc-session-scope";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

function scopeWith(files: { name: string; bytes: number }[]): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-gc-scope-"));
	temporaryDirectories.push(root);
	for (const file of files) {
		const full = path.join(root, file.name);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, Buffer.alloc(file.bytes, 0));
	}
	return root;
}

describe("gc session scope usage", () => {
	it("reports a scope under the budget as ok and stays silent", async () => {
		const root = scopeWith([{ name: "a.jsonl", bytes: 1024 }]);
		const usage = await collectSessionScopeUsage(root, 1024 * 1024);

		expect(usage.status).toBe("ok");
		expect(usage.total_bytes).toBe(1024);
		expect(usage.entries).toBe(1);
		expect(usage.truncated).toBe(false);
		// An ok scope must not be surfaced — gc output stays unchanged for
		// everyone who is nowhere near the budget.
		expect(shouldReportSessionScope(usage)).toBe(false);
	});

	it("flags a scope past the notice ratio before it fails", async () => {
		// 80% of the budget: still launchable, but the operator should hear it.
		const root = scopeWith([{ name: "big.jsonl", bytes: 800 }]);
		const usage = await collectSessionScopeUsage(root, 1000);

		expect(usage.status).toBe("approaching_limit");
		expect(shouldReportSessionScope(usage)).toBe(true);
	});

	it("flags a scope over the budget", async () => {
		const root = scopeWith([
			{ name: "one.jsonl", bytes: 600 },
			{ name: "nested/two.jsonl", bytes: 600 },
		]);
		const usage = await collectSessionScopeUsage(root, 1000);

		expect(usage.status).toBe("over_limit");
		expect(usage.total_bytes).toBe(1200);
		// The nested directory is counted as an entry alongside its file.
		expect(usage.entries).toBe(3);
		expect(shouldReportSessionScope(usage)).toBe(true);
	});

	it("reports a missing scope as unavailable instead of throwing", async () => {
		const usage = await collectSessionScopeUsage(path.join(os.tmpdir(), "gjc-gc-scope-does-not-exist"), 1000);

		expect(usage.status).toBe("unavailable");
		expect(usage.reason).toBe("scope_not_found");
		expect(shouldReportSessionScope(usage)).toBe(false);
	});

	it("reports a non-directory scope path as unavailable", async () => {
		const root = scopeWith([{ name: "file", bytes: 1 }]);
		const usage = await collectSessionScopeUsage(path.join(root, "file"), 1000);

		expect(usage.status).toBe("unavailable");
		expect(usage.reason).toBe("not_a_directory");
	});

	it("keeps counting past an unreadable subtree rather than failing the probe", async () => {
		const root = scopeWith([
			{ name: "readable.jsonl", bytes: 500 },
			{ name: "locked/inner.jsonl", bytes: 500 },
		]);
		const locked = path.join(root, "locked");
		fs.chmodSync(locked, 0o000);

		let usage: GcSessionScopeUsage;
		try {
			usage = await collectSessionScopeUsage(root, 1000);
		} finally {
			fs.chmodSync(locked, 0o700);
		}

		// The unreadable subtree is skipped, but the readable side still counts,
		// so the answer to "am I near the budget?" survives a partial walk.
		expect(usage.status).not.toBe("unavailable");
		expect(usage.total_bytes).toBeGreaterThanOrEqual(500);
	});
});
