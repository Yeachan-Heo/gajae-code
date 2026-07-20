import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { openRecoveryFsRoot } from "../native/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-recovery-fs-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe.skipIf(process.platform !== "linux")("native recovery filesystem authority", () => {
	it("creates, installs, fsyncs, and reports descriptor identities", async () => {
		const root = await temporaryDirectory();
		const authority = openRecoveryFsRoot(root);

		const created = authority.create("state.tmp", Buffer.from('{"generation":1}\n'));
		expect(created).toMatchObject({ ok: true, identity: { size: "17" } });
		expect(authority.install("state.tmp", "state.json")).toMatchObject({ ok: true });
		expect(authority.stat("state.json")).toMatchObject({ ok: true, identity: created.identity });
		const read = authority.read("state.json", 1024);
		expect(read.ok).toBe(true);
		expect(Buffer.from(read.data ?? [])).toEqual(Buffer.from('{"generation":1}\n'));
		expect(authority.fsync()).toMatchObject({ ok: true });
		expect(authority.close()).toMatchObject({ ok: true });
		expect(authority.stat("state.json")).toEqual({ ok: false, code: "closed" });
	});

	it("rejects traversal, symlinks, special files, hard links, and oversized content", async () => {
		const root = await temporaryDirectory();
		const authority = openRecoveryFsRoot(root);
		await fs.writeFile(path.join(root, "regular"), "trusted");
		await fs.link(path.join(root, "regular"), path.join(root, "hard-link"));
		await fs.symlink("regular", path.join(root, "link"));
		const fifo = path.join(root, "receipt.fifo");
		const mkfifo = Bun.spawn(["mkfifo", fifo], { stdout: "ignore", stderr: "ignore" });
		expect(await mkfifo.exited).toBe(0);

		expect(authority.stat("../outside")).toMatchObject({ ok: false, code: "invalid_path" });
		expect(authority.read("link", 1024)).toMatchObject({ ok: false, code: "reparse_point" });
		expect(authority.stat("receipt.fifo")).toMatchObject({ ok: false, code: "not_regular_file" });
		expect(authority.stat("hard-link")).toMatchObject({ ok: false, code: "hard_link" });
		expect(authority.create("too-large", Buffer.alloc(1024 * 1024 + 1))).toMatchObject({
			ok: false,
			code: "content_too_large",
		});
		expect(authority.close()).toMatchObject({ ok: true });
	});

	it("continues to use the retained root descriptor after the root pathname is swapped", async () => {
		const parent = await temporaryDirectory();
		const root = path.join(parent, "root");
		const retained = path.join(parent, "retained");
		const replacement = path.join(parent, "replacement");
		await fs.mkdir(root);
		await fs.mkdir(replacement);
		const authority = openRecoveryFsRoot(root);
		await fs.rename(root, retained);
		await fs.symlink(replacement, root, "dir");

		expect(authority.create("receipt.tmp", Buffer.from("receipt"))).toMatchObject({ ok: true });
		expect(await fs.readFile(path.join(retained, "receipt.tmp"), "utf8")).toBe("receipt");
		expect(await fs.readdir(replacement)).toEqual([]);
		expect(authority.close()).toMatchObject({ ok: true });
	});

	it("refuses to replace an existing install destination", async () => {
		const root = await temporaryDirectory();
		const authority = openRecoveryFsRoot(root);
		expect(authority.create("candidate", Buffer.from("candidate"))).toMatchObject({ ok: true });
		expect(authority.create("receipt", Buffer.from("existing"))).toMatchObject({ ok: true });
		expect(authority.install("candidate", "receipt")).toMatchObject({ ok: false, code: "already_exists" });
		expect(await fs.readFile(path.join(root, "candidate"), "utf8")).toBe("candidate");
		expect(await fs.readFile(path.join(root, "receipt"), "utf8")).toBe("existing");
		expect(authority.close()).toMatchObject({ ok: true });
	});
});
