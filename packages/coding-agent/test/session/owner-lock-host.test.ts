import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStorage } from "../../src/session/session-storage";

describe("host-qualified transcript authority locks", () => {
	let directory: string;
	let file: string;
	const storage = new FileSessionStorage();
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-lock-host-"));
		file = path.join(directory, "owner.lock");
	});
	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});
	async function seed(hostId?: string): Promise<string> {
		const bytes = `${JSON.stringify({ pid: 2_147_483_647, incarnation: "dead-incarnation", token: "old-generation", ...(hostId === undefined ? {} : { hostId }) })}\n`;
		await Bun.write(file, bytes);
		await fs.chmod(file, 0o600);
		return bytes;
	}

	it("refuses foreign-host and unqualified records even when that PID is absent locally", async () => {
		for (const host of ["foreign-host", undefined]) {
			const bytes = await seed(host);
			expect(storage.acquireExclusiveLockSync(file, { ownerHostId: "local-host" })).toBeUndefined();
			expect(await Bun.file(file).text()).toBe(bytes);
			await fs.unlink(file);
		}
	});

	it("recovers only a proven dead generation of the same host and publishes the current host", async () => {
		await seed("local-host");
		const lock = storage.acquireExclusiveLockSync(file, { ownerHostId: "local-host" });
		expect(lock).toBeDefined();
		const record = await Bun.file(file).json();
		expect(record.hostId).toBe("local-host");
		expect(record.pid).toBe(process.pid);
		expect(typeof record.incarnation).toBe("string");
		expect(record.token).not.toBe("old-generation");
		lock!.releaseSync();
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("an unqualified caller cannot reclaim a qualified foreign generation", async () => {
		const bytes = await seed("foreign-host");
		expect(storage.acquireExclusiveLockSync(file)).toBeUndefined();
		expect(await Bun.file(file).text()).toBe(bytes);
	});

	it("a late release never removes a successor lock generation", async () => {
		const lock = storage.acquireExclusiveLockSync(file, { ownerHostId: "local-host" });
		expect(lock).toBeDefined();
		await fs.unlink(file);
		const successor = await seed("successor-host");
		lock!.releaseSync();
		expect(await Bun.file(file).text()).toBe(successor);
	});
});
