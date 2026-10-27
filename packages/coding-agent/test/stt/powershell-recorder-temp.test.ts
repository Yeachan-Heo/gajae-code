import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const worker = path.join(import.meta.dir, "powershell-recorder-temp-run.ts");
const packageDir = path.resolve(import.meta.dir, "../..");
const created: string[] = [];

function canSymlink(): boolean {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-stt-link-probe-"));
	try {
		const target = path.join(dir, "t");
		const link = path.join(dir, "l");
		fs.writeFileSync(target, "x");
		fs.symlinkSync(target, link);
		return fs.lstatSync(link).isSymbolicLink();
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const symlinkOk = canSymlink();

afterEach(() => {
	for (const entry of created.splice(0)) fs.rmSync(entry, { recursive: true, force: true });
});

function runIsolated(mode: "allow" | "attack"): Promise<{ status: number; stderr: string; root: string }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-stt-test-root-"));
	created.push(root);
	return new Promise(resolve => {
		const child = spawn(process.execPath, [worker, mode], {
			cwd: packageDir,
			env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("close", status => resolve({ status: status ?? 1, stderr, root }));
	});
}

describe("PowerShell recorder temp file", () => {
	it("still allows a recorder script write when no temp symlink is planted", async () => {
		const result = await runIsolated("allow");
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});

	if (!symlinkOk) {
		it.skip("does not follow a preexisting symlink at the predictable temp name", () => {});
	}
	if (symlinkOk)
		it("does not follow a preexisting symlink at the predictable temp name", async () => {
			const result = await runIsolated("attack");
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
		});

	it("keeps an unrelated temp directory while recorder tests run", async () => {
		const sentinelRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-stt-sentinel-"));
		created.push(sentinelRoot);
		const sentinel = path.join(sentinelRoot, "gjc-stt-record-sentinel");
		fs.mkdirSync(sentinel);
		fs.writeFileSync(path.join(sentinel, "keep.txt"), "KEEP");
		const [left, right] = await Promise.all([runIsolated("allow"), runIsolated("allow")]);
		expect(left.stderr).toBe("");
		expect(right.stderr).toBe("");
		expect(left.status).toBe(0);
		expect(right.status).toBe(0);
		expect(fs.readFileSync(path.join(sentinel, "keep.txt"), "utf8")).toBe("KEEP");
		expect(fs.statSync(sentinel).isDirectory()).toBe(true);
	});
});
