import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	captureManagedFileNoFollow,
	prepareManagedDirectoryRoot,
	replaceManagedFileSync,
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
		const transcript = path.join(root.canonicalPath, "session.jsonl");
		fs.writeFileSync(transcript, "before\n", { mode: 0o600 });

		replaceManagedFileSync(
			transcript,
			Buffer.from("after\n"),
			root,
			"default",
			undefined,
			captureManagedFileNoFollow(transcript).identity,
		);

		expect(fs.readFileSync(transcript, "utf8")).toBe("after\n");
		const predecessors = fs
			.readdirSync(root.canonicalPath)
			.filter(entry => entry.startsWith(".session.jsonl.") && entry.endsWith(".replacement"));
		expect(predecessors).toHaveLength(1);
		expect(fs.readFileSync(path.join(root.canonicalPath, predecessors[0]), "utf8")).toBe("before\n");
	});
});
