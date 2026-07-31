import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import {
	daemonPaths,
	NOTIFICATION_LEAK_ARTIFACT_GRACE_MS,
	reapStaleNotificationArtifacts,
	registerNotificationRoot,
	type TelegramDaemonFs,
} from "../src/sdk/bus/telegram-daemon";

function isolatedSettings(agentDir: string): Settings {
	const isolated = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
	}) as Settings;
	return new Proxy(isolated, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

/** Wrap the real fs so publishing `roots` fails the way a locked/denied rename does. */
function renameFailingFs(rootsPath: string): TelegramDaemonFs {
	const base = fs.promises as unknown as TelegramDaemonFs;
	return {
		...base,
		rename: async (oldPath: string, newPath: string): Promise<void> => {
			if (path.resolve(newPath) === path.resolve(rootsPath)) {
				const error = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			await base.rename(oldPath, newPath);
		},
	};
}

function stagingTempFiles(dir: string): string[] {
	return fs.readdirSync(dir).filter(name => name.endsWith(".tmp"));
}

/** Drive a publication failure so the writer abandons one staging temp on disk. */
async function leakOneStagingTemp(agentDir: string, sessionId: string): Promise<void> {
	const paths = daemonPaths(agentDir);
	await expect(
		registerNotificationRoot({
			settings: isolatedSettings(agentDir),
			cwd: agentDir,
			sessionId,
			fs: renameFailingFs(paths.roots),
		}),
	).rejects.toThrow(/EPERM/);
}

test("the notification reaper reclaims staging temps abandoned by a failed publication", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-staging-leak-"));
	const paths = daemonPaths(agentDir);

	for (let attempt = 0; attempt < 3; attempt++) await leakOneStagingTemp(agentDir, `session-${attempt}`);
	// Precondition: publication really did abandon its staged temps.
	expect(stagingTempFiles(paths.dir)).toHaveLength(3);

	// Advance the reaper's clock past the grace window rather than zeroing the
	// window: a temp written in the same millisecond can carry a fractional mtime
	// slightly ahead of an integer `Date.now()`, which reads as negative age and
	// is treated as still-staging.
	const result = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		now: () => Date.now() + NOTIFICATION_LEAK_ARTIFACT_GRACE_MS + 60_000,
	});

	expect(stagingTempFiles(paths.dir)).toEqual([]);
	expect(result.removed).toHaveLength(3);
});

test("the notification reaper leaves a staging temp younger than the grace window alone", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-staging-leak-"));
	const paths = daemonPaths(agentDir);

	await leakOneStagingTemp(agentDir, "session-fresh");
	const [fresh] = stagingTempFiles(paths.dir);
	expect(fresh).toBeString();

	// A concurrent publication that is still staging its temp must never have it
	// reaped out from under the pending rename.
	const result = await reapStaleNotificationArtifacts({ settings: isolatedSettings(agentDir) });

	expect(stagingTempFiles(paths.dir)).toEqual([fresh!]);
	expect(result.removed).toEqual([]);
	expect(result.skipped).toBeGreaterThan(0);
});

test("the notification reaper never removes a published notification file", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-staging-leak-"));
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	// Published names carry no `.tmp` suffix, and a `.json.1.2.abc` shaped name is
	// not a staging temp either; neither may be reaped.
	fs.writeFileSync(paths.roots, '{"version":1,"roots":[]}\n');
	const decoy = path.join(paths.dir, "telegram-daemon.roots.json.1.2.abc");
	fs.writeFileSync(decoy, "{}\n");

	const result = await reapStaleNotificationArtifacts({ settings: isolatedSettings(agentDir), graceMs: 0 });

	expect(fs.existsSync(paths.roots)).toBe(true);
	expect(fs.existsSync(decoy)).toBe(true);
	expect(result.removed).toEqual([]);
});
