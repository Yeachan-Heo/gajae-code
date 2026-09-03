import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	SessionStateLockTestHooks,
	SessionStateLockUnavailableError,
	setSessionStateLockNativeBindings,
	withSessionStateFileLock,
} from "../src/gjc-runtime/session-state-lock";
import { exactIdentityNativeBindings } from "./helpers/exact-identity-natives";

const probe = path.join(import.meta.dir, "fixtures", "session-state-lock-forced-exit-probe.ts");
const roots: string[] = [];
const DEAD_PID = 2 ** 22 - 1;

async function waitForFile(file: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await fs.exists(file)) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${file}`);
}

async function seedDeadTransition(root: string, token: string): Promise<{ stateFile: string; transitionDir: string }> {
	const stateFile = path.join(root, "runtime-state.json");
	const transitionDir = `${stateFile}.lock.transition`;
	await fs.mkdir(transitionDir);
	await fs.writeFile(
		`${transitionDir}.owner`,
		JSON.stringify({
			pid: DEAD_PID,
			start_time: "unknown",
			token,
			owner_host_id: "forced-exit-probe-host",
		}),
	);
	return { stateFile, transitionDir };
}

function installLocalIdentityBindings(): void {
	setSessionStateLockNativeBindings(() => exactIdentityNativeBindings);
	SessionStateLockTestHooks.ownerHostId = () => "forced-exit-probe-host";
	SessionStateLockTestHooks.legacyOwnerHostId = () => "forced-exit-probe-legacy-host";
	SessionStateLockTestHooks.unqualifiedOwnerIsLocal = false;
}

afterEach(async () => {
	SessionStateLockTestHooks.ownerHostId = undefined;
	SessionStateLockTestHooks.legacyOwnerHostId = undefined;
	SessionStateLockTestHooks.unqualifiedOwnerIsLocal = undefined;
	SessionStateLockTestHooks.afterTransitionClaimContention = undefined;
	setSessionStateLockNativeBindings(undefined);
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("session-state lock forced-exit recovery", () => {
	it("keeps SIGTERM bounded and immediately reclaims the dead cleanup owner", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-forced-exit-lock-"));
		roots.push(root);
		const stateFile = path.join(root, "runtime-state.json");
		const child = Bun.spawn([process.execPath, probe, root], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: { ...process.env, GJC_CLEANUP_DEADLINE_MS: "100" },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			await waitForFile(path.join(root, "ready"));
			const signaledAt = performance.now();
			child.kill("SIGTERM");
			const exit = await Promise.race([child.exited, Bun.sleep(2_000).then(() => "timeout" as const)]);
			expect(exit).toBe(143);
			expect(performance.now() - signaledAt).toBeLessThan(1_000);
			const transitionDir = `${stateFile}.lock.transition`;
			expect(await fs.exists(transitionDir)).toBe(true);
			expect(JSON.parse(await fs.readFile(`${transitionDir}.owner`, "utf8"))).toMatchObject({
				pid: child.pid,
				owner_host_id: "forced-exit-probe-host",
			});

			installLocalIdentityBindings();
			const sleep = vi.spyOn(Bun, "sleep");

			await expect(withSessionStateFileLock(stateFile, async () => "resumed")).resolves.toBe("resumed");
			expect(sleep).not.toHaveBeenCalled();
			expect(await fs.exists(transitionDir)).toBe(false);
		} finally {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await child.exited;
			}
		}
	}, 10_000);

	it("keeps backoff when an EEXIST claim disappears before inspection", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-transition-disappeared-"));
		roots.push(root);
		const { stateFile, transitionDir } = await seedDeadTransition(root, "disappeared-before-inspection");
		installLocalIdentityBindings();
		let injected = false;
		SessionStateLockTestHooks.afterTransitionClaimContention = async contended => {
			if (injected || contended !== transitionDir) return;
			injected = true;
			await fs.rm(transitionDir, { recursive: true, force: true });
			await fs.rm(`${transitionDir}.owner`, { force: true });
		};
		const sleep = vi.spyOn(Bun, "sleep");

		await expect(withSessionStateFileLock(stateFile, async () => "resumed")).resolves.toBe("resumed");
		expect(injected).toBe(true);
		expect(sleep).toHaveBeenCalled();
	});

	it("keeps backoff when exact removal reports a lost not_found race", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-transition-not-found-"));
		roots.push(root);
		const { stateFile, transitionDir } = await seedDeadTransition(root, "native-not-found-race");
		installLocalIdentityBindings();
		setSessionStateLockNativeBindings(() => ({
			...exactIdentityNativeBindings,
			exactRemoveDirectoryTree(target, snapshot) {
				const removed = exactIdentityNativeBindings.exactRemoveDirectoryTree(target, snapshot);
				if (!removed.ok) return removed;
				return { ok: false, code: "not_found" };
			},
		}));
		const sleep = vi.spyOn(Bun, "sleep");

		await expect(withSessionStateFileLock(stateFile, async () => "resumed")).resolves.toBe("resumed");
		expect(await fs.exists(transitionDir)).toBe(false);
		expect(sleep).toHaveBeenCalled();
	});

	it("immediately retries after a durable cleanup_pending transition detach", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-transition-cleanup-pending-"));
		roots.push(root);
		const { stateFile, transitionDir } = await seedDeadTransition(root, "cleanup-pending-reclaimed");
		installLocalIdentityBindings();
		setSessionStateLockNativeBindings(() => ({
			...exactIdentityNativeBindings,
			exactRemoveDirectoryTree(target) {
				const detachedPath = `${target}.removing`;
				fsSync.renameSync(target, detachedPath);
				return {
					ok: false,
					code: "cleanup_pending",
					payloadDurable: true,
					detachedPath,
				};
			},
		}));
		const sleep = vi.spyOn(Bun, "sleep");

		await expect(withSessionStateFileLock(stateFile, async () => "resumed")).resolves.toBe("resumed");
		expect(sleep).not.toHaveBeenCalled();
		expect(await fs.exists(`${transitionDir}.removing`)).toBe(false);
	});

	it("refuses a cleanup_pending transition receipt that is not durable", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-transition-cleanup-refused-"));
		roots.push(root);
		const { stateFile, transitionDir } = await seedDeadTransition(root, "cleanup-pending-refused");
		const detachedPath = `${transitionDir}.removing`;
		installLocalIdentityBindings();
		setSessionStateLockNativeBindings(() => ({
			...exactIdentityNativeBindings,
			exactRemoveDirectoryTree(target) {
				fsSync.renameSync(target, detachedPath);
				return {
					ok: false,
					code: "cleanup_pending",
					payloadDurable: false,
					detachedPath,
				};
			},
		}));

		await expect(withSessionStateFileLock(stateFile, async () => "not-entered")).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);
		expect(await fs.exists(transitionDir)).toBe(false);
		expect(await fs.exists(detachedPath)).toBe(true);
	});

	it("bounds repeated successful dead-claim reclaims without sleeping", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-transition-reclaim-loop-"));
		roots.push(root);
		const { stateFile, transitionDir } = await seedDeadTransition(root, "reclaim-loop-0");
		const ownerFile = `${transitionDir}.owner`;
		installLocalIdentityBindings();
		let elapsedMs = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			const current = elapsedMs;
			elapsedMs += 1_000;
			return current;
		});
		let reclaims = 0;
		setSessionStateLockNativeBindings(() => ({
			...exactIdentityNativeBindings,
			exactRemoveDirectoryTree(target, snapshot) {
				const removed = exactIdentityNativeBindings.exactRemoveDirectoryTree(target, snapshot);
				if (!removed.ok) return removed;
				reclaims++;
				if (reclaims >= 4) throw new Error("reclaim loop escaped its deadline");
				fsSync.rmSync(ownerFile, { force: true });
				fsSync.mkdirSync(transitionDir);
				fsSync.writeFileSync(
					ownerFile,
					JSON.stringify({
						pid: DEAD_PID,
						start_time: "unknown",
						token: `reclaim-loop-${reclaims}`,
						owner_host_id: "forced-exit-probe-host",
					}),
				);
				return removed;
			},
		}));
		const sleep = vi.spyOn(Bun, "sleep");

		const failure = await withSessionStateFileLock(stateFile, async () => "not-entered").catch(error => error);
		expect(failure).toBeInstanceOf(SessionStateLockUnavailableError);
		expect(failure).toMatchObject({
			lockPath: transitionDir,
			reason: "transition_claim_timeout",
		});
		expect(reclaims).toBeGreaterThan(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("immediately retries after exact removal of a dead legacy transition record", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-legacy-transition-reclaimed-"));
		roots.push(root);
		const stateFile = path.join(root, "runtime-state.json");
		const transitionFile = `${stateFile}.lock.transition`;
		await fs.writeFile(
			transitionFile,
			JSON.stringify({
				pid: DEAD_PID,
				start_time: "unknown",
				token: "legacy-transition-reclaimed",
				owner_host_id: "forced-exit-probe-host",
			}),
		);
		installLocalIdentityBindings();
		const sleep = vi.spyOn(Bun, "sleep");

		await expect(withSessionStateFileLock(stateFile, async () => "resumed")).resolves.toBe("resumed");
		expect(sleep).not.toHaveBeenCalled();
	});

	it("keeps backoff when a dead legacy transition record disappears during exact removal", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-legacy-transition-not-found-"));
		roots.push(root);
		const stateFile = path.join(root, "runtime-state.json");
		const transitionFile = `${stateFile}.lock.transition`;
		await fs.writeFile(
			transitionFile,
			JSON.stringify({
				pid: DEAD_PID,
				start_time: "unknown",
				token: "legacy-transition-not-found",
				owner_host_id: "forced-exit-probe-host",
			}),
		);
		installLocalIdentityBindings();
		setSessionStateLockNativeBindings(() => ({
			...exactIdentityNativeBindings,
			exactUnlink(file, identity) {
				const removed = exactIdentityNativeBindings.exactUnlink(file, identity);
				if (!removed.ok) return removed;
				return { ok: false, code: "not_found" };
			},
		}));
		const sleep = vi.spyOn(Bun, "sleep");

		await expect(withSessionStateFileLock(stateFile, async () => "resumed")).resolves.toBe("resumed");
		expect(sleep).toHaveBeenCalled();
	});
});
