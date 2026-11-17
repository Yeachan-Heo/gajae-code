import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "../src/logger";

const dirs: string[] = [];
afterEach(async () => {
	await logger.close();
	logger.setTransports({ console: false, file: false });
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function readLogs(dir: string): string {
	if (!fs.existsSync(dir)) return "";
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".log"))
		.map(name => fs.readFileSync(path.join(dir, name), "utf8"))
		.join("");
}

it("flushes a just-written record and leaves nothing to recreate a removed log directory", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-logger-close-"));
	dirs.push(dir);
	logger.setTransports({ file: dir });

	// Written before the lazy logger and its file stream exist.
	logger.warn("written before close");
	await logger.close();
	expect(readLogs(dir)).toContain("written before close");

	fs.rmSync(dir, { recursive: true, force: true });
	await Bun.sleep(200);
	expect(fs.existsSync(dir)).toBe(false);

	// A later write opens the file again.
	logger.warn("written after close");
	await logger.close();
	expect(readLogs(dir)).toContain("written after close");
});

it("resolves when nothing was logged", async () => {
	await logger.close();
	await logger.close();
});

it("returns within its deadline when the file stream never finishes", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-logger-close-stuck-"));
	dirs.push(dir);
	logger.setTransports({ file: dir });
	logger.warn("before a wedged sink");
	await logger.close();
	logger.warn("open again");
	// Wedge every Writable end so neither the end callback nor "finish" arrives.
	const { Writable } = await import("node:stream");
	const end = vi.spyOn(Writable.prototype, "end").mockImplementation(function (this: unknown) {
		return this as never;
	});
	try {
		const started = Date.now();
		await logger.close();
		expect(Date.now() - started).toBeLessThan(4_000);
	} finally {
		end.mockRestore();
	}
});

it("gives concurrent callers the same barrier, so neither resolves before the file is written", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-logger-close-concurrent-"));
	dirs.push(dir);
	logger.setTransports({ file: dir });
	logger.warn("written before concurrent close");
	const first = logger.close();
	const second = logger.close();
	expect(second).toBe(first);
	await second;
	expect(readLogs(dir)).toContain("written before concurrent close");
});
