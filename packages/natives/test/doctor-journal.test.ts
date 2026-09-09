import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { configTargetId, resolveDoctorRoot } from "../../coding-agent/src/cli/doctor/ids";
import { DoctorJournal } from "../../coding-agent/src/cli/doctor/journal";
import { DoctorJournalAuthority } from "../native";

const roots: string[] = [];
const journals: DoctorJournal[] = [];
afterEach(async () => {
	for (const journal of journals.splice(0)) journal.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-native-journal-")));
	roots.push(root);
	return root;
}

describe("doctor journal authority", () => {
	test("rejects traversal and distinguishes malformed canonical input", async () => {
		const root = await fixture();
		await expect(DoctorJournal.create(root, "../escape")).rejects.toThrow();
		const journalPath = path.join(root, "doctor", "repairs", "run", "journal.ndjson");
		expect((await DoctorJournal.readDetailed(journalPath)).status).toBe("missing");
		await fs.mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
		await Bun.write(journalPath, "{not-json}\n");
		await fs.chmod(journalPath, 0o600);
		expect((await DoctorJournal.readDetailed(journalPath)).status).toBe("malformed");
	});

	test("does not follow a replacement symlink or serialize unknown secret values", async () => {
		const root = await fixture();
		const journal = await DoctorJournal.create(root, "run");
		journals.push(journal);
		const targetId = configTargetId(resolveDoctorRoot("config-user", root).rootId, "user", "skills.enabled");
		await journal.append({
			repairId: "config.set-validated",
			targetId,
			phase: "before",
			before: { value: "secret-sentinel" },
		});
		expect(await Bun.file(journal.path).text()).not.toContain("secret-sentinel");
		const foreign = path.join(root, "foreign");
		await Bun.write(foreign, "preserve-foreign");
		await fs.unlink(journal.path);
		await fs.symlink(foreign, journal.path);
		await expect(journal.append({ repairId: "config.set-validated", targetId, phase: "before" })).rejects.toThrow();
		expect(await Bun.file(foreign).text()).toBe("preserve-foreign");
	});

	test("bounds native append before writing and returns typed duplicate-create effects", async () => {
		const root = await fixture();
		const result = DoctorJournalAuthority.createExact(root, "bounded");
		expect(result.sideEffectStarted).toBe(true);
		expect(result.authority).toBeDefined();
		const authority = result.authority!;
		try {
			expect(() => authority.append("x".repeat(128 * 1024))).toThrow();
			expect(await Bun.file(path.join(root, "doctor", "repairs", "bounded", "journal.ndjson")).text()).toBe("");
			const duplicate = DoctorJournalAuthority.createExact(root, "bounded");
			expect(duplicate).toMatchObject({ sideEffectStarted: false, reasonCode: "already_exists" });
			expect(duplicate.authority).toBeUndefined();
		} finally {
			authority.close();
		}
	});
});
