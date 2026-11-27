import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import {
	claimSessionOwner,
	probeSessionOwner,
	probeSessionOwners,
	type SessionOwnerClaim,
	SessionOwnershipTestHooks,
	sessionOwnerHolderPhrase,
	sessionOwnerKey,
	sessionOwnersDirectory,
} from "../../src/session/session-ownership";

const supported = process.platform === "linux" || process.platform === "darwin";
const holderScript = path.join(import.meta.dir, "session-ownership-holder-child.ts");
const TIMEOUT_MS = 60_000;

let home: string;
const children: Subprocess<"pipe", "pipe", "pipe">[] = [];
const strayPids: number[] = [];
const claims: SessionOwnerClaim[] = [];

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function recordPath(sessionId: string): string {
	return path.join(sessionOwnersDirectory(), `${sessionOwnerKey(sessionId)}.owner.json`);
}

/** The test preload's isolated home, restored after each test. */
let preloadHome: string | undefined;

beforeEach(async () => {
	home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-ownership-proc-")));
	preloadHome = SessionOwnershipTestHooks.homeOverride;
	SessionOwnershipTestHooks.homeOverride = home;
	if (!sessionOwnersDirectory().startsWith(`${home}${path.sep}`)) throw new Error("owners directory escaped");
});

afterEach(async () => {
	try {
		for (const claim of claims.splice(0)) claim.release();
	} finally {
		for (const child of children.splice(0)) {
			child.kill("SIGKILL");
			await child.exited;
		}
		for (const pid of strayPids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
		SessionOwnershipTestHooks.homeOverride = preloadHome;
		await fs.rm(home, { recursive: true, force: true });
	}
});

interface Holder {
	child: Subprocess<"pipe", "pipe", "pipe">;
	ready: { status: string; pid: number; grandchild: number | null };
	nextLine(): Promise<string>;
}

/** Start a process, with `HOME` at the temp home, that claims `sessionId` and reports its ready line. */
async function startHolder(sessionId: string, surface: string, grandchildPidFile?: string): Promise<Holder> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		OWNER_SESSION_ID: sessionId,
		OWNER_SURFACE: surface,
	};
	// The child resolves its directories from HOME alone, never from the runner's XDG or gjc overrides.
	for (const key of Object.keys(env))
		if (key.startsWith("XDG_") || /^(GJC|PI)_(CONFIG|CODING_AGENT)_DIR$/.test(key)) delete env[key];
	if (grandchildPidFile) env.OWNER_GRANDCHILD_PID_FILE = grandchildPidFile;
	const child = Bun.spawn([process.execPath, holderScript], {
		cwd: import.meta.dir,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	const nextLine = async (): Promise<string> => {
		while (!buffered.includes("\n")) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`holder exited early: ${await new Response(child.stderr).text()}`);
			buffered += decoder.decode(value, { stream: true });
		}
		const index = buffered.indexOf("\n");
		const line = buffered.slice(0, index);
		buffered = buffered.slice(index + 1);
		return line;
	};
	const ready = JSON.parse(await nextLine()) as Holder["ready"];
	if (ready.grandchild !== null && ready.grandchild !== undefined) strayPids.push(ready.grandchild);
	expect(ready.status).toBe("claimed");
	return { child, ready, nextLine };
}

async function claimHere(sessionId: string): Promise<SessionOwnerClaim> {
	const result = await claimSessionOwner(sessionId, { surface: "terminal" });
	if (result.status !== "claimed") throw new Error(`expected a claim, got ${result.status}`);
	claims.push(result.claim);
	return result.claim;
}

describe.if(supported)("session ownership across processes", () => {
	it(
		"names another process's claim, refuses to take it, and frees it on release",
		async () => {
			const holder = await startHolder("p1", "print");
			expect(holder.ready.pid).toBe(holder.child.pid);
			const expected = { state: "held", self: false, holder: { surface: "print", pid: holder.child.pid } };
			expect(await probeSessionOwner("p1")).toMatchObject(expected);
			const refused = await claimSessionOwner("p1", { surface: "terminal" });
			expect(refused).toMatchObject({ status: "held", holder: { surface: "print", pid: holder.child.pid } });
			if (refused.status === "held") {
				expect(sessionOwnerHolderPhrase(refused.holder)).toBe(`a gjc -p run (pid ${holder.child.pid})`);
			}

			holder.child.stdin.write("release\n");
			await holder.child.stdin.flush();
			expect(await holder.nextLine()).toBe("released");
			expect(await Bun.file(recordPath("p1")).exists()).toBe(false);
			expect(await probeSessionOwner("p1")).toEqual({ state: "free" });
			expect((await claimHere("p1")).shared).toBe(false);
		},
		TIMEOUT_MS,
	);

	it(
		"kill -9 frees the claim at once, and the stale record is ignored and replaced",
		async () => {
			const holder = await startHolder("p2", "terminal");
			holder.child.kill("SIGKILL");
			await holder.child.exited;

			expect(JSON.parse(await fs.readFile(recordPath("p2"), "utf8"))).toMatchObject({ pid: holder.child.pid });
			expect(await probeSessionOwner("p2")).toEqual({ state: "free" });
			await claimHere("p2");
			expect(JSON.parse(await fs.readFile(recordPath("p2"), "utf8"))).toMatchObject({ pid: process.pid });
		},
		TIMEOUT_MS,
	);

	it(
		"a grandchild spawned by the holder does not keep the claim",
		async () => {
			const holder = await startHolder("p3", "sdk-host", path.join(home, "grandchild.pid"));
			const grandchild = holder.ready.grandchild;
			expect(grandchild).toBeNumber();
			holder.child.kill("SIGKILL");
			await holder.child.exited;
			expect(alive(grandchild as number)).toBe(true);
			expect(await probeSessionOwner("p3")).toEqual({ state: "free" });
			await claimHere("p3");
		},
		TIMEOUT_MS,
	);

	it(
		"shows a record only for a live holder with a matching incarnation on this host",
		async () => {
			const holder = await startHolder("p4", "app");
			const original = JSON.parse(await fs.readFile(recordPath("p4"), "utf8")) as Record<string, unknown>;
			const rewrite = (fields: Record<string, unknown>) =>
				Bun.write(recordPath("p4"), JSON.stringify({ ...original, ...fields }));

			const exited = Bun.spawn(["/bin/sh", "-c", "exit 0"]);
			await exited.exited;
			await rewrite({ pid: exited.pid });
			expect(await probeSessionOwner("p4")).toEqual({ state: "held", self: false, holder: undefined });

			await rewrite({ pid: process.pid, processIncarnation: "linux:1" });
			expect(await probeSessionOwner("p4")).toEqual({ state: "held", self: false, holder: undefined });

			await rewrite({ sessionId: "another-session" });
			expect(await probeSessionOwner("p4")).toEqual({ state: "held", self: false, holder: undefined });

			// A live pid without an incarnation is only "uncertain", never proof of the holder.
			await rewrite({ processIncarnation: null });
			expect(await probeSessionOwner("p4")).toEqual({ state: "held", self: false, holder: undefined });

			// A host name that is not a plain host name never reaches a phrase.
			await rewrite({ host: "evil host/../x", pid: exited.pid });
			expect(await probeSessionOwner("p4")).toEqual({ state: "held", self: false, holder: undefined });

			await Bun.write(recordPath("p4"), "not json");
			expect(await probeSessionOwner("p4")).toEqual({ state: "held", self: false, holder: undefined });

			// Another host's pid cannot be checked here; the host itself is the label.
			await rewrite({ host: "build-box.example", pid: exited.pid });
			expect(await probeSessionOwner("p4")).toMatchObject({
				state: "held",
				holder: { surface: "app", pid: exited.pid, host: "build-box.example" },
			});

			// A live local holder stays local after the host is renamed.
			await rewrite({ host: "renamed-host.example" });
			const renamed = await probeSessionOwner("p4");
			expect(renamed).toMatchObject({ state: "held", holder: { surface: "app", pid: holder.child.pid } });
			expect(renamed.state === "held" && renamed.holder?.host).toBeUndefined();

			await rewrite({});
			expect(await probeSessionOwner("p4")).toMatchObject({ holder: { surface: "app", pid: holder.child.pid } });
		},
		TIMEOUT_MS,
	);

	it(
		"a batch probe answers for held, own and free sessions together",
		async () => {
			const holder = await startHolder("p5", "acp-host");
			await claimHere("p6");
			const results = await probeSessionOwners(["p5", "p6", "p7"]);
			expect(results.get("p5")).toMatchObject({
				state: "held",
				self: false,
				holder: { surface: "acp-host", pid: holder.child.pid },
			});
			expect(results.get("p6")).toMatchObject({ state: "held", self: true, holder: { pid: process.pid } });
			expect(results.get("p7")).toEqual({ state: "free" });
		},
		TIMEOUT_MS,
	);
});
