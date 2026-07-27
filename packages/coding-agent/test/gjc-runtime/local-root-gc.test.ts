import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GcContext } from "../../src/gjc-runtime/gc-runtime";
import { localRootsGcAdapter } from "../../src/internal-urls/local-root-gc";

/**
 * `resolveLocalRoot` gives every session its own `<tmp>/gjc-local/<session-id>`
 * directory and seeds it with a migration marker. Nothing removed them, so a
 * machine accumulated one per session forever — mostly marker-only, because most
 * sessions never write a `local://` file.
 *
 * Eligibility is deliberately narrow: marker-only **and** past a grace window.
 * A directory holding real content is never touched, and a session that just
 * started is still inside its window, so no liveness oracle is needed.
 */

const MARKER = ".gjc-local-legacy-migrated-v1";
const PAST_GRACE_MS = 25 * 60 * 60 * 1000;

const tempDirs: string[] = [];

function makeTmpRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-local-gc-test-"));
	tempDirs.push(dir);
	fs.mkdirSync(path.join(dir, "gjc-local"), { recursive: true });
	return dir;
}

function seedRoot(tmpRoot: string, id: string, opts: { extra?: string; ageMs?: number } = {}): string {
	const dir = path.join(tmpRoot, "gjc-local", id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, MARKER), "absent\n");
	if (opts.extra) fs.writeFileSync(path.join(dir, opts.extra), "payload");
	if (opts.ageMs) {
		const when = new Date(Date.now() - opts.ageMs);
		fs.utimesSync(dir, when, when);
	}
	return dir;
}

function ctxFor(tmpRoot: string): GcContext {
	return {
		probe: (() => "dead") as unknown as GcContext["probe"],
		force: false,
		env: { ...process.env, TMPDIR: tmpRoot },
		cwd: process.cwd(),
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("local root GC", () => {
	it("reports nothing when the parent directory does not exist", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-local-gc-empty-"));
		tempDirs.push(dir);
		const result = await localRootsGcAdapter.collect(ctxFor(dir));
		expect(result.records).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("marks a marker-only root past the grace window as removable", async () => {
		const tmpRoot = makeTmpRoot();
		seedRoot(tmpRoot, "stale-session", { ageMs: PAST_GRACE_MS });
		const [record] = (await localRootsGcAdapter.collect(ctxFor(tmpRoot))).records;
		expect(record.status).toBe("marker_only");
		expect(record.stale).toBe(true);
		expect(record.removable).toBe(true);
		expect(record.action).toBe("would_remove");
	});

	it("keeps a marker-only root that is still inside the grace window", async () => {
		const tmpRoot = makeTmpRoot();
		seedRoot(tmpRoot, "fresh-session");
		const [record] = (await localRootsGcAdapter.collect(ctxFor(tmpRoot))).records;
		expect(record.status).toBe("recent");
		expect(record.removable).toBe(false);
	});

	it("keeps a root that holds real content, however old", async () => {
		const tmpRoot = makeTmpRoot();
		seedRoot(tmpRoot, "used-session", { extra: "notes.md", ageMs: PAST_GRACE_MS });
		const [record] = (await localRootsGcAdapter.collect(ctxFor(tmpRoot))).records;
		expect(record.status).toBe("in_use");
		expect(record.removable).toBe(false);
	});

	it("removes an eligible root on prune", async () => {
		const tmpRoot = makeTmpRoot();
		const dir = seedRoot(tmpRoot, "stale-session", { ageMs: PAST_GRACE_MS });
		const [record] = (await localRootsGcAdapter.collect(ctxFor(tmpRoot))).records;
		expect(await localRootsGcAdapter.prune(record, ctxFor(tmpRoot))).toEqual({ removed: true });
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("re-validates at prune time and skips a root that became used", async () => {
		const tmpRoot = makeTmpRoot();
		const dir = seedRoot(tmpRoot, "racy-session", { ageMs: PAST_GRACE_MS });
		const [record] = (await localRootsGcAdapter.collect(ctxFor(tmpRoot))).records;
		expect(record.removable).toBe(true);

		// The session writes a file between collect and prune.
		fs.writeFileSync(path.join(dir, "late.md"), "payload");

		const outcome = await localRootsGcAdapter.prune(record, ctxFor(tmpRoot));
		expect(outcome.removed).toBe(false);
		expect(outcome.skipped).toContain("in_use");
		expect(fs.existsSync(dir)).toBe(true);
	});

	it("classifies a mixed parent directory independently", async () => {
		const tmpRoot = makeTmpRoot();
		seedRoot(tmpRoot, "a-stale", { ageMs: PAST_GRACE_MS });
		seedRoot(tmpRoot, "b-fresh");
		seedRoot(tmpRoot, "c-used", { extra: "data.bin", ageMs: PAST_GRACE_MS });

		const records = (await localRootsGcAdapter.collect(ctxFor(tmpRoot))).records;
		const byId = new Map(records.map(r => [r.id, r]));
		expect(byId.get("a-stale")?.removable).toBe(true);
		expect(byId.get("b-fresh")?.removable).toBe(false);
		expect(byId.get("c-used")?.removable).toBe(false);
	});
});
