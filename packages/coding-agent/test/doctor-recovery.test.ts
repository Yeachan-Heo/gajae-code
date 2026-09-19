import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { configTargetId, resolveDoctorRoot } from "../src/cli/doctor/ids";
import { DoctorJournal, reconcileDoctorEvidence, reconcileDoctorJournal } from "../src/cli/doctor/journal";
import type { DoctorCheck } from "../src/cli/doctor/types";

const roots: string[] = [];
const handles: DoctorJournal[] = [];
afterEach(async () => {
	for (const handle of handles.splice(0)) handle.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-journal-")));
	roots.push(root);
	await fs.chmod(root, 0o755);
	const journal = await DoctorJournal.create(root, "run");
	handles.push(journal);
	const targetId = configTargetId(resolveDoctorRoot("config-user", root).rootId, "user", "skills.enabled");
	return { root, journal, targetId };
}
function observed(targetId: string, enabled: boolean): DoctorCheck {
	return {
		id: "config.user.skills.enabled",
		targetId,
		execution: "completed",
		health: "ok",
		evidenceLevel: "observed",
		evidence: { enabled },
		dependsOn: [],
		remediationIds: [],
	};
}

describe("doctor journal recovery", () => {
	test("never promotes a historical verified phase without fresh selected evidence", async () => {
		const { journal, targetId } = await fixture();
		await journal.append({ repairId: "config.set-validated", targetId, phase: "before", before: { value: false } });
		await journal.append({
			repairId: "config.set-validated",
			targetId,
			phase: "verified",
			after: { value: true },
			outcome: "verified",
		});
		expect((await reconcileDoctorJournal(journal.path))?.outcome).toBe("unknown");
		const last = (await DoctorJournal.read(journal.path)).at(-1)!;
		expect(reconcileDoctorEvidence(last, { check: observed(targetId, false), current: { value: false } })).toBe(
			"conflict",
		);
		expect(reconcileDoctorEvidence(last, { check: observed(targetId, true), current: { value: true } })).toBe(
			"verified",
		);
		expect(
			reconcileDoctorEvidence({ ...last, before: {}, after: {} }, { check: observed(targetId, true), current: {} }),
		).toBe("unknown");
		expect(
			reconcileDoctorEvidence(last, {
				check: { ...observed(targetId, true), execution: "blocked" },
				current: { value: true },
			}),
		).toBe("unknown");
	});

	test("rejects a replaced run directory without appending to either object", async () => {
		const { root, journal, targetId } = await fixture();
		const run = path.dirname(journal.path);
		const old = path.join(root, "retained-run");
		const before = await Bun.file(journal.path).text();
		await fs.rename(run, old);
		await fs.mkdir(run, { mode: 0o700 });
		await Bun.write(journal.path, "foreign-content");
		await fs.chmod(journal.path, 0o600);
		await expect(journal.append({ repairId: "config.set-validated", targetId, phase: "before" })).rejects.toThrow();
		expect(await Bun.file(journal.path).text()).toBe("foreign-content");
		expect(await Bun.file(path.join(old, "journal.ndjson")).text()).toBe(before);
	});

	test("keeps existing runs exclusive and marks a torn final line malformed", async () => {
		const { root, journal } = await fixture();
		await expect(DoctorJournal.create(root, "run")).rejects.toMatchObject({
			sideEffectStarted: false,
			reasonCode: "already_exists",
		});
		journal.close();
		const raw = await Bun.file(journal.path).text();
		await Bun.write(journal.path, raw.slice(0, -1));
		const read = await DoctorJournal.readDetailed(journal.path);
		expect(read.status).toBe("malformed");
		expect(read.malformedLines).toEqual([1]);
	});
});
