import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { collectSessionOwnersProbe } from "../../src/cli/doctor/session-owners-probe";
import { collectSessionOwnersReport, renderSessionOwnersText } from "../../src/cli/session-owners-cli";
import {
	claimSessionOwner,
	heldSessionClaims,
	type SessionOwnerClaim,
	SessionOwnershipTestHooks,
	sessionOwnerKey,
	sessionOwnersDirectory,
} from "../../src/session/session-ownership";

const supported = process.platform === "linux" || process.platform === "darwin";
const holderScript = path.join(import.meta.dir, "session-ownership-holder-child.ts");
const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
const bunConfig = path.resolve(import.meta.dir, "../../src/sdk/broker/internal-source.bunfig.toml");
const TIMEOUT_MS = 90_000;
const ESC = "\u001b";

let home: string;
let preloadHome: string | undefined;
const children: Subprocess<"pipe", "pipe", "pipe">[] = [];
const claims: SessionOwnerClaim[] = [];

beforeEach(async () => {
	home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-owners-")));
	preloadHome = SessionOwnershipTestHooks.homeOverride;
	SessionOwnershipTestHooks.homeOverride = home;
});

afterEach(async () => {
	try {
		for (const claim of claims.splice(0)) claim.release();
	} finally {
		for (const child of children.splice(0)) {
			child.kill("SIGKILL");
			await child.exited;
		}
		SessionOwnershipTestHooks.homeOverride = preloadHome;
		await fs.rm(home, { recursive: true, force: true });
	}
});

function recordPath(sessionId: string): string {
	return path.join(sessionOwnersDirectory(), `${sessionOwnerKey(sessionId)}.owner.json`);
}

/** A process with `HOME` at the temp home that claims `sessionId` and keeps it until killed. */
async function startHolder(sessionId: string, surface: string): Promise<number> {
	const child = Bun.spawn([process.execPath, holderScript], {
		cwd: import.meta.dir,
		env: { ...process.env, HOME: home, OWNER_SESSION_ID: sessionId, OWNER_SURFACE: surface },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const reader = child.stdout.getReader();
	let line = "";
	while (!line.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`holder exited early: ${await new Response(child.stderr).text()}`);
		line += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	expect(JSON.parse(line)).toMatchObject({ status: "claimed" });
	return child.pid;
}

async function deadPid(): Promise<number> {
	const exited = Bun.spawn(["/bin/sh", "-c", "exit 0"]);
	await exited.exited;
	return exited.pid;
}

async function rewriteRecord(sessionId: string, fields: Record<string, unknown>): Promise<void> {
	const original = JSON.parse(await fs.readFile(recordPath(sessionId), "utf8")) as Record<string, unknown>;
	await Bun.write(recordPath(sessionId), JSON.stringify({ ...original, ...fields }));
}

/** Bytes, inode and mtime of every entry under `directory`. */
async function snapshot(directory: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const name of (await fs.readdir(directory)).sort()) {
		const file = path.join(directory, name);
		const stat = await fs.lstat(file);
		result[name] = `${stat.ino}:${stat.mtimeMs}:${stat.size}:${await fs.readFile(file, "base64")}`;
	}
	return result;
}

async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
	const profile = path.join(home, "profile");
	const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${bunConfig}`, cli, ...args], {
		cwd: home,
		env: {
			PATH: process.env.PATH,
			HOME: home,
			GJC_CODING_AGENT_DIR: profile,
			XDG_CONFIG_HOME: path.join(home, "xdg"),
			XDG_DATA_HOME: path.join(home, "xdg"),
			XDG_STATE_HOME: path.join(home, "xdg"),
			XDG_CACHE_HOME: path.join(home, "xdg"),
			TMPDIR: home,
			NO_COLOR: "1",
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return { stdout, exitCode };
}

describe("gjc session owners without an owners directory", () => {
	it("reports none and creates nothing", async () => {
		const report = await collectSessionOwnersReport();
		expect(report).toEqual({
			directory: "missing",
			sidecars: 0,
			records: 0,
			unrecognized: 0,
			diskBytes: 0,
			owners: [],
		});
		expect(renderSessionOwnersText(report)).toEqual([
			"No session owners directory: no session has been claimed under this home.",
		]);
		expect(await fs.readdir(home)).toEqual([]);
	});
});

describe.if(supported)("gjc session owners", () => {
	it(
		"lists this process tree's claims apart from other holders, in text and --json",
		async () => {
			const other = await startHolder("other-session", "print");
			const own = await claimSessionOwner("own-session", { surface: "terminal" });
			if (own.status !== "claimed") throw new Error(own.status);
			claims.push(own.claim);
			expect(heldSessionClaims()).toEqual([
				expect.objectContaining({ sessionId: "own-session", surface: "terminal", shares: 1 }),
			]);

			const report = await collectSessionOwnersReport();
			expect(report).toMatchObject({ directory: "present", sidecars: 2, records: 2, unrecognized: 0 });
			expect(report.diskBytes).toBeGreaterThan(0);
			expect(report.owners).toEqual([
				expect.objectContaining({
					key: "other-session",
					sessionId: "other-session",
					state: "held",
					self: false,
					processTree: false,
					record: "verified",
					holder: expect.objectContaining({ surface: "print", pid: other }),
				}),
				expect.objectContaining({
					key: "own-session",
					self: true,
					processTree: true,
					holder: expect.objectContaining({ surface: "terminal", pid: process.pid }),
				}),
			]);
			const text = renderSessionOwnersText(report).join("\n");
			expect(text).toMatch(/Held by this process tree:\n {2}own-session {2}terminal {2}pid \d+ {2}held /);
			expect(text).toContain(`Held by other processes:\n  other-session  print  pid ${other}  held `);

			// The CLI is this test process's child, so this process's claim is in its process tree.
			const before = await snapshot(sessionOwnersDirectory());
			const result = await runCli(["session", "owners", "--json"]);
			expect(result.exitCode).toBe(0);
			const json = JSON.parse(result.stdout);
			expect(json).toMatchObject({ ok: true, directory: "present", sidecars: 2 });
			expect(
				json.owners.map((owner: { key: string; processTree: boolean; self: boolean }) => [
					owner.key,
					owner.processTree,
					owner.self,
				]),
			).toEqual([
				["other-session", false, false],
				["own-session", true, false],
			]);
			expect(json.owners[1].ageMs).toBeNumber();
			expect(await snapshot(sessionOwnersDirectory())).toEqual(before);
		},
		TIMEOUT_MS,
	);

	it(
		"never prints hostile record fields or file names",
		async () => {
			const hostileId = `id${ESC}[2Jcleared`;
			await startHolder(hostileId, "app");
			const verified = await startHolder("verified-session", "sdk-host");
			await rewriteRecord("verified-session", {
				claimedAt: `${ESC}[31m2026-01-01T00:00:00.000Z`,
				gjcVersion: `1.0${ESC}]0;title${ESC}\\`,
				host: `evil${ESC}[1mhost`,
			});
			await startHolder("foreign-session", "terminal");
			await rewriteRecord("foreign-session", { host: `bad host${ESC}[5m`, pid: await deadPid() });
			await Bun.write(path.join(sessionOwnersDirectory(), `evil${ESC}[31m.session-owner`), "");

			const report = await collectSessionOwnersReport();
			expect(report.unrecognized).toBe(1);
			const hostile = report.owners.find(owner => owner.key === sessionOwnerKey(hostileId));
			expect(hostile).toMatchObject({ record: "verified", holder: { surface: "app" } });
			expect(hostile?.sessionId).toBeUndefined();
			const clean = report.owners.find(owner => owner.key === "verified-session");
			expect(clean?.holder).toEqual({
				surface: "sdk-host",
				pid: verified,
				gjcVersion: undefined,
				claimedAt: undefined,
			});
			expect(clean?.ageMs).toBeUndefined();
			const foreign = report.owners.find(owner => owner.key === "foreign-session");
			expect(foreign?.record).toBe("unverified");
			expect(foreign?.holder).toBeUndefined();

			const text = renderSessionOwnersText(report).join("\n");
			const json = JSON.stringify(report);
			for (const output of [text, json]) {
				expect(output).not.toContain(ESC);
				expect(output).not.toContain("\\u001b");
				expect(output).not.toContain("evil");
				expect(output).not.toContain("cleared");
			}
			expect(text).toContain(`${sessionOwnerKey(hostileId)}  app  pid `);
		},
		TIMEOUT_MS,
	);
});

describe.if(supported)("gjc doctor session owners check", () => {
	it(
		"flags a held claim whose holder pid is gone, without touching the owners directory",
		async () => {
			await startHolder("stale-session", "terminal");
			await startHolder("live-session", "terminal");
			const gone = await deadPid();
			await rewriteRecord("stale-session", { pid: gone, processIncarnation: null });
			const before = await snapshot(sessionOwnersDirectory());

			const result = await runCli(["doctor", "--json", "--check", "session"]);
			const report = JSON.parse(result.stdout);
			const byId = new Map(report.checks.map((check: { id: string }) => [check.id, check]));
			expect(byId.get("session.owners.holders")).toMatchObject({
				execution: "completed",
				health: "warning",
				reasonCode: "session_owner_holder_gone",
				evidence: { count: 2, counts: { holderGone: 1 } },
			});
			expect(byId.get("session.owners.sidecars")).toMatchObject({
				health: "ok",
				reasonCode: "session_owner_sidecars_within_limit",
				evidence: { count: 2 },
			});
			expect(result.stdout).not.toContain(String(gone));
			expect(await snapshot(sessionOwnersDirectory())).toEqual(before);
		},
		TIMEOUT_MS,
	);

	it(
		"does not flag a record that a live holder replaces before the second look",
		async () => {
			const holder = await startHolder("handoff-session", "terminal");
			const live = JSON.parse(await fs.readFile(recordPath("handoff-session"), "utf8"));
			await rewriteRecord("handoff-session", { pid: await deadPid(), processIncarnation: null });
			const probe = collectSessionOwnersProbe(500);
			await Bun.sleep(100);
			await Bun.write(recordPath("handoff-session"), JSON.stringify(live));
			const receipt = await probe;
			expect(receipt.checks[0]).toMatchObject({ health: "ok", reasonCode: "session_owner_holders_consistent" });
			expect(live.pid).toBe(holder);
		},
		TIMEOUT_MS,
	);

	it("warns when sidecars exceed the limit", async () => {
		const owners = sessionOwnersDirectory();
		await fs.mkdir(owners, { recursive: true, mode: 0o700 });
		await fs.chmod(path.dirname(owners), 0o700);
		await fs.chmod(path.dirname(path.dirname(owners)), 0o700);
		// Free, owner-only sidecars, as claims leave them.
		for (const key of ["a", "b", "c"])
			await fs.writeFile(path.join(owners, `${key}.session-owner`), "", { mode: 0o600 });
		const receipt = await collectSessionOwnersProbe(0, 2);
		expect(receipt.checks[1]).toMatchObject({
			id: "session.owners.sidecars",
			health: "warning",
			reasonCode: "session_owner_sidecars_over_limit",
			evidence: { count: 3 },
		});
		expect(receipt.checks[0]).toMatchObject({ health: "ok", evidence: { count: 0 } });
	});

	it("is not applicable on a home that never claimed, and creates nothing", async () => {
		const result = await runCli(["doctor", "--json", "--check", "session"]);
		const report = JSON.parse(result.stdout);
		expect(report.checks.map((check: { id: string; reasonCode: string }) => [check.id, check.reasonCode])).toEqual([
			["session.owners.holders", "session_owners_absent"],
			["session.owners.sidecars", "session_owners_absent"],
		]);
		await expect(fs.lstat(path.join(home, ".gjc", "runtime"))).rejects.toThrow();
	});
});
