import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DeliveryJournal } from "../src/delivery-journal";

const directories: string[] = [];
async function directory(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-delivery-"));
	directories.push(dir);
	return dir;
}
afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("delivery journal", () => {
	test("serializes duplicate admission and preserves metadata across restart", async () => {
		const dir = await directory();
		const journal = new DeliveryJournal(dir);
		await journal.initialize();
		const results = await Promise.allSettled([journal.begin("one", "session"), journal.begin("one", "session")]);
		expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
		await journal.update("one", { disposition: "queued", sdkSubmissionId: "sdk" });
		await journal.begin("two", "session");
		await journal.update("two", { disposition: "removed" });
		const restored = new DeliveryJournal(dir);
		await restored.initialize();
		expect(restored.list()).toEqual([
			{ id: "one", sessionId: "session", disposition: "unknown", sdkSubmissionId: "sdk" },
			{ id: "two", sessionId: "session", disposition: "removed" },
		]);
		await expect(restored.begin("one", "session")).rejects.toThrow("Duplicate delivery id");
		await restored.ack("one");
		await restored.ack("one");
		await restored.ack("two");
		expect(JSON.parse(await Bun.file(path.join(dir, "deliveries.json")).text())).toEqual({
			version: 1,
			receipts: [],
			acknowledged: ["one", "two"],
		});
		const afterAck = new DeliveryJournal(dir);
		await afterAck.initialize();
		await afterAck.ack("one");
		await afterAck.ack("missing");
		await afterAck.ack("missing");
		await expect(afterAck.begin("missing", "session")).rejects.toThrow("Duplicate delivery id");
		await expect(afterAck.begin("one", "session")).rejects.toThrow("Duplicate delivery id");
	});

	test("ack rejects active receipts and late observers cannot overwrite finals", async () => {
		const journal = new DeliveryJournal(await directory());
		await journal.initialize();
		await journal.begin("id", "session");
		for (const disposition of ["pending", "accepted", "queued"] as const) {
			await journal.update("id", { disposition });
			await expect(journal.ack("id")).rejects.toThrow("not final");
		}
		await journal.update("id", { disposition: "cancelled" });
		await journal.update("id", { disposition: "accepted" });
		expect(journal.list()[0]?.disposition).toBe("cancelled");
		await journal.ack("id");
		await journal.update("id", { disposition: "completed" });
		expect(journal.list()).toEqual([]);
	});

	test("failed persistence does not admit an in-memory delivery", async () => {
		const dir = await directory();
		const blocked = path.join(dir, "blocked");
		const journal = new DeliveryJournal(blocked);
		await journal.initialize();
		await fs.writeFile(blocked, "not a directory");
		await expect(journal.begin("id", "session")).rejects.toThrow();
		expect(journal.list()).toEqual([]);
		expect(await fs.readFile(blocked, "utf8")).toBe("not a directory");
	});

	test("a failed transition is unknown in memory and after restart", async () => {
		const dir = await directory();
		const journal = new DeliveryJournal(dir);
		await journal.initialize();
		await journal.begin("id", "session");
		const moved = `${dir}-moved`;
		directories.push(moved);
		await fs.rename(dir, moved);
		await fs.writeFile(dir, "not a directory");
		await expect(journal.update("id", { disposition: "accepted" })).rejects.toThrow();
		expect(journal.list()).toContainEqual(expect.objectContaining({ id: "id", disposition: "unknown" }));
		expect(JSON.parse(await fs.readFile(path.join(moved, "deliveries.json"), "utf8")).receipts).toEqual([
			{ id: "id", sessionId: "session", disposition: "pending" },
		]);
		const restored = new DeliveryJournal(moved);
		await restored.initialize();
		expect(restored.list()).toContainEqual(expect.objectContaining({ id: "id", disposition: "unknown" }));
	});

	test("sync failure never commits admission in memory", async () => {
		const dir = await directory();
		const journal = new DeliveryJournal(dir);
		await journal.initialize();
		const probe = await fs.open(path.join(dir, "probe"), "w");
		const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
		await probe.close();
		const sync = vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("sync failed"));
		await expect(journal.begin("id", "session")).rejects.toThrow("sync failed");
		expect(sync).toHaveBeenCalled();
		expect(journal.list()).toEqual([]);
		sync.mockRestore();
		const restored = new DeliveryJournal(dir);
		await restored.initialize();
		expect(restored.list()).toEqual([]);
	});

	test("directory sync failure after rename remains unknown across restart", async () => {
		const dir = await directory();
		const journal = new DeliveryJournal(dir);
		await journal.initialize();
		await journal.begin("id", "session");
		const probe = await fs.open(path.join(dir, "probe"), "w");
		const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
		await probe.close();
		const original = prototype.sync;
		let calls = 0;
		const sync = vi.spyOn(prototype, "sync").mockImplementation(function (this: typeof probe) {
			if (++calls === 2) return Promise.reject(new Error("directory sync failed"));
			return original.call(this);
		});
		await expect(journal.update("id", { disposition: "accepted" })).rejects.toThrow("directory sync failed");
		expect(journal.list()).toContainEqual(expect.objectContaining({ id: "id", disposition: "unknown" }));
		sync.mockRestore();
		const restored = new DeliveryJournal(dir);
		await restored.initialize();
		expect(restored.list()).toContainEqual(expect.objectContaining({ id: "id", disposition: "unknown" }));
	});

	test("competing lifecycle transitions never regress a terminal outcome", async () => {
		const journal = new DeliveryJournal(await directory());
		await journal.initialize();
		await journal.begin("id", "session");
		await Promise.all([
			journal.update("id", { disposition: "removed" }),
			journal.update("id", { disposition: "accepted" }),
			journal.update("id", { disposition: "completed" }),
		]);
		expect(journal.list()).toEqual([{ id: "id", sessionId: "session", disposition: "removed" }]);
	});

	test("invalid persisted data fails closed", async () => {
		const dir = await directory();
		await Bun.write(
			path.join(dir, "deliveries.json"),
			JSON.stringify({
				version: 1,
				receipts: [{ id: "id", sessionId: "session", disposition: "invented" }],
				acknowledged: [],
			}),
		);
		await expect(new DeliveryJournal(dir).initialize()).rejects.toThrow("Invalid delivery journal");
	});
});
