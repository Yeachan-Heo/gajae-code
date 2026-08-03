import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDarwinReplacementAuth } from "@gajae-code/natives";
import {
	ManagedSessionDescendantStore,
	prepareManagedDirectoryRoot,
} from "../src/session/internal/managed-session-storage";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Darwin managed replacement", () => {
	it("atomically replaces an existing managed transcript without retaining predecessor artifacts", () => {
		if (process.platform !== "darwin") return;
		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-darwin-managed-replace-"));
		tempDirectories.push(temporaryDirectory);
		const root = prepareManagedDirectoryRoot(temporaryDirectory);
		const store = new ManagedSessionDescendantStore(root, root.canonicalPath);
		const transcript = path.join(root.canonicalPath, "session.jsonl");
		store.publishNoReplaceSync("session.jsonl", Buffer.from("before\n"));
		const expected = store.readExpected("session.jsonl");
		if (!expected) throw new Error("managed transcript was not published");

		store.replaceExpected("session.jsonl", Buffer.from("after\n"), expected);

		expect(fs.readFileSync(transcript, "utf8")).toBe("after\n");
		expect(
			fs
				.readdirSync(root.canonicalPath)
				.some(
					entry =>
						entry.includes(".replacement") ||
						entry.startsWith(".gjc-darwin-replacement-") ||
						entry === ".gjc-managed-session-internal",
				),
		).toBe(false);
	});
	it("rejects append while the Darwin replacement admission is held", () => {
		if (process.platform !== "darwin") return;
		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-darwin-managed-append-"));
		tempDirectories.push(temporaryDirectory);
		const root = prepareManagedDirectoryRoot(temporaryDirectory);
		const store = new ManagedSessionDescendantStore(root, root.canonicalPath);
		const transcript = path.join(root.canonicalPath, "session.jsonl");
		store.publishNoReplaceSync("session.jsonl", Buffer.from("before\n"));

		const auth = openDarwinReplacementAuth(root.canonicalPath, "darwin-replacement-admission.lock");
		try {
			expect(() => store.appendSync("session.jsonl", Buffer.from("append\n"))).toThrow("migration_busy");
			expect(fs.readFileSync(transcript, "utf8")).toBe("before\n");
		} finally {
			auth.close();
		}
	});
	it("rejects removal while the Darwin replacement admission is held", () => {
		if (process.platform !== "darwin") return;
		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-darwin-managed-remove-"));
		tempDirectories.push(temporaryDirectory);
		const root = prepareManagedDirectoryRoot(temporaryDirectory);
		const store = new ManagedSessionDescendantStore(root, root.canonicalPath);
		const transcript = path.join(root.canonicalPath, "session.jsonl");
		store.publishNoReplaceSync("session.jsonl", Buffer.from("before\n"));
		const expected = store.readExpected("session.jsonl");
		if (!expected) throw new Error("managed transcript was not published");

		const auth = openDarwinReplacementAuth(root.canonicalPath, "darwin-replacement-admission.lock");
		try {
			expect(() => store.removeExpected("session.jsonl", expected)).toThrow("migration_busy");
			expect(fs.readFileSync(transcript, "utf8")).toBe("before\n");
		} finally {
			auth.close();
		}
	});
});
