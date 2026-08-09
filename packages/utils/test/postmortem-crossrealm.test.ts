import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { recordFatalCrash } from "../src/postmortem";

const tempCrashLog = (): string =>
	path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-crossrealm-")), "gjc-crash.log");

const record = (reason: unknown): string => {
	const target = tempCrashLog();
	recordFatalCrash("Uncaught Exception", reason, { path: target, now: new Date("2026-01-01T00:00:00.000Z") });
	return fs.readFileSync(target, "utf8");
};

it("keeps the message and stack of a cross-realm Error", () => {
	const thrown = vm.runInNewContext(
		"(() => { const error = new Error('cross-realm boom'); error.stack = 'CrossRealmStack'; return error; })()",
	) as unknown;
	expect(thrown instanceof Error).toBe(false);

	const contents = record(thrown);
	expect(contents).toContain("Error: cross-realm boom");
	expect(contents).toContain("CrossRealmStack");
});

it("keeps existing rendering for plain objects, strings, and null", () => {
	expect(record({ phase: "startup", reason: "broken" })).toContain('Error: {"phase":"startup","reason":"broken"}');
	expect(record("plain string")).toContain("Error: plain string");
	expect(record(null)).toContain("Error: null");
});
