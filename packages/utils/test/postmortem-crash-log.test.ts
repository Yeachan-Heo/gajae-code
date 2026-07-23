import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordFatalCrash } from "../src/postmortem";

function tempCrashLog(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-crash-log-"));
	// Nested path proves the writer creates missing parent directories.
	return path.join(dir, "agent", "gjc-crash.log");
}

describe("recordFatalCrash", () => {
	it("writes a structured, diagnosable record for an Error", () => {
		const target = tempCrashLog();
		const err = new Error("boom while streaming");
		const now = new Date("2026-07-23T21:22:31.647Z");

		const written = recordFatalCrash("Uncaught Exception", err, { path: target, now });

		expect(written).toBe(target);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("2026-07-23T21:22:31.647Z");
		expect(contents).toContain(`pid=${process.pid}`);
		expect(contents).toContain("[Uncaught Exception]");
		expect(contents).toContain("Error: boom while streaming");
		// The full stack must be present so the crash is actually diagnosable.
		expect(contents).toContain(err.stack ?? "MISSING_STACK");
	});

	it("stringifies non-Error rejection reasons", () => {
		const target = tempCrashLog();
		const written = recordFatalCrash("Unhandled Rejection", "Request was aborted", { path: target });
		expect(written).toBe(target);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("[Unhandled Rejection]");
		expect(contents).toContain("Request was aborted");
	});

	it("appends successive crashes rather than overwriting", () => {
		const target = tempCrashLog();
		recordFatalCrash("Uncaught Exception", new Error("first"), { path: target });
		recordFatalCrash("Uncaught Exception", new Error("second"), { path: target });
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("Error: first");
		expect(contents).toContain("Error: second");
		expect(contents.indexOf("first")).toBeLessThan(contents.indexOf("second"));
	});

	it("resets past the size cap so a crash loop cannot grow unbounded", () => {
		const target = tempCrashLog();
		fs.mkdirSync(path.dirname(target), { recursive: true });
		// Pre-fill beyond the 512KB cap.
		fs.writeFileSync(target, "x".repeat(600 * 1024));
		recordFatalCrash("Uncaught Exception", new Error("post-cap crash"), { path: target });
		const size = fs.statSync(target).size;
		expect(size).toBeLessThan(512 * 1024);
		const contents = fs.readFileSync(target, "utf8");
		expect(contents).toContain("Error: post-cap crash");
		// Old oversized content is gone; newest crash retained.
		expect(contents).not.toContain("x".repeat(1024));
	});

	it("never throws when the target path is unwritable", () => {
		// A path whose parent is an existing file cannot be created as a directory.
		const fileAsParent = tempCrashLog();
		fs.mkdirSync(path.dirname(fileAsParent), { recursive: true });
		fs.writeFileSync(fileAsParent, "i am a file");
		const bogus = path.join(fileAsParent, "nested", "gjc-crash.log");
		const result = recordFatalCrash("Uncaught Exception", new Error("x"), { path: bogus });
		expect(result).toBeUndefined();
	});
});
