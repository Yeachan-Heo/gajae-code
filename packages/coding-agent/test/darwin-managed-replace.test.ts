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
	it("atomically replaces an existing managed transcript while retaining its predecessor", () => {
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
		const predecessors = fs
			.readdirSync(root.canonicalPath)
			.filter(entry => entry.startsWith(".session.jsonl.") && entry.endsWith(".replacement"));
		expect(predecessors).toHaveLength(1);
		expect(fs.readFileSync(path.join(root.canonicalPath, predecessors[0]), "utf8")).toBe("before\n");
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
});
