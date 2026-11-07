import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

// Everything before this pinned sibling publication inside one process. The goal is two real
// TUIs, so the same claim is checked across the process boundary here: two children are spawned
// before either is awaited, each opens the same managed transcript, and each publishes three
// appends through the shared seam.
//
// What this pins: every append commits or is refused with a stated reason, all six commits reach
// disk under the ids the children were told, and every parent link resolves.
// What it does not pin: that the two children actually interleave (the run may still serialize as
// "A opens and commits, then B opens and commits"), that either is unblocked while the other is
// alive, and anything about interactive TUIs, provider ownership or cleanup ownership.

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const worker = path.join(import.meta.dirname, "fixtures", "shared-session-append-worker.ts");

describe("two processes appending to one transcript", () => {
	it("publishes every commit from two concurrently spawned processes", async () => {
		const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-two-process-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const writer = SessionManager.create(cwd, destination);
		writer.appendMessage({ role: "user" as const, content: "shared root", timestamp: 1 });
		await writer.ensureOnDisk();
		const file = writer.getSessionFile();
		if (!file) throw new Error("expected a transcript path");
		await writer.closeStrict();

		const spawn = (label: string) =>
			Bun.spawn([process.execPath, worker, cwd, agentDir, file, label, "3"], {
				stdout: "pipe",
				stderr: "pipe",
			});
		// Spawned back to back with no await between them, so both children are alive together.
		const first = spawn("A");
		const second = spawn("B");
		const [firstOut, secondOut, firstErr, secondErr] = await Promise.all([
			new Response(first.stdout).text(),
			new Response(second.stdout).text(),
			new Response(first.stderr).text(),
			new Response(second.stderr).text(),
		]);
		const [firstCode, secondCode] = await Promise.all([first.exited, second.exited]);
		// A worker death has to name its cause, not just report a non-zero status.
		expect({ label: "A", code: firstCode, stderr: firstErr, stdout: firstOut }).toMatchObject({ code: 0 });
		expect({ label: "B", code: secondCode, stderr: secondErr, stdout: secondOut }).toMatchObject({ code: 0 });

		const parse = (raw: string) =>
			raw
				.trim()
				.split("\n")
				.filter(Boolean)
				.flatMap(
					line =>
						JSON.parse(line) as { label: string; index: number; kind: string; id?: string; reason?: string }[],
				);
		const outcomes = [...parse(firstOut), ...parse(secondOut)];
		// Every append either committed or was refused with a stated reason; a crash or a silent
		// drop shows up here, and the reason itself is checked rather than discarded.
		for (const outcome of outcomes) {
			expect(["committed", "stale", "rejected"]).toContain(outcome.kind);
			if (outcome.kind !== "committed") expect(outcome.reason?.trim().length ?? 0).toBeGreaterThan(0);
		}
		const committed = outcomes.filter(outcome => outcome.kind === "committed");
		// Exact, not a floor: each child publishes three, so a run where one child's chain was
		// truncated mid-flight must fail rather than clear a ">= 4" bar.
		expect(committed).toHaveLength(6);

		// One transcript holds both processes' content, and a fresh reader sees every commit.
		const reopened = await SessionManager.open(file, destination);
		const text = JSON.stringify(reopened.getEntries());
		for (const outcome of committed) expect(text).toContain(`${outcome.label}-${outcome.index}`);
		// Each committed outcome is on disk under the id the child was told about, and every
		// parent link in the resulting graph resolves.
		const entries = reopened.getEntries();
		const ids = new Set(entries.map(entry => entry.id));
		for (const outcome of committed) expect(ids.has(outcome.id ?? "")).toBe(true);
		for (const entry of entries) if (entry.parentId) expect(ids.has(entry.parentId)).toBe(true);
		await reopened.closeStrict().catch(() => undefined);
	}, 60_000);
});
