import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describeManagedLink } from "../src/cli/doctor/managed-link";

// macOS APFS gives the same volume a different st_dev after a reboot (#5990). A receipt written
// before the reboot still names our link by inode and must keep vouching for it.

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function linkWithReceipt(recordedDev: (actual: string) => string, recordedIno?: string) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-link-boot-")));
	roots.push(root);
	const source = path.join(root, "packages/coding-agent/src/cli.ts");
	await fs.mkdir(path.dirname(source), { recursive: true });
	await fs.writeFile(source, "");
	const bin = path.join(root, "bin");
	await fs.mkdir(bin);
	const target = path.join(bin, "gjc");
	await fs.symlink(source, target);
	const stat = await fs.lstat(target);
	const body = {
		version: 1,
		alias: "gjc",
		target,
		root,
		source,
		parent: bin,
		identity: { dev: recordedDev(String(stat.dev)), ino: recordedIno ?? String(stat.ino) },
	};
	const auth = createHash("sha256").update(JSON.stringify(body)).digest("hex");
	await fs.writeFile(`${target}.gjc-managed.json`, `${JSON.stringify({ ...body, auth })}\n`, { mode: 0o600 });
	await fs.chmod(`${target}.gjc-managed.json`, 0o600);
	return { root, target };
}

describe("managed link doctor: receipt identity across reboots (#5990)", () => {
	it("#given a receipt that recorded a different st_dev for the same link #when described #then the link is still owned and healthy", async () => {
		// given
		const f = await linkWithReceipt(actual => String(Number(actual) + 1));

		// when
		const d = await describeManagedLink(f.target, f.root);

		// then
		expect(d.receiptTrusted).toBe(true);
		expect(d.status).toBe("healthy");
	});

	it("#given a receipt whose inode does not match the link #when described #then ownership is still refused", async () => {
		// given
		const f = await linkWithReceipt(actual => actual, "1");

		// when
		const d = await describeManagedLink(f.target, f.root);

		// then
		expect(d.receiptTrusted).toBe(false);
		expect(d.status).toBe("foreign");
	});
});
