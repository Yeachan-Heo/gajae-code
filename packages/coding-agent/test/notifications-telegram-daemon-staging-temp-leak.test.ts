import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { exactUnlinkNotificationFile, readNotificationEndpointFile } from "../src/sdk/bus/notification-service";
import {
	daemonPaths,
	NOTIFICATION_LEAK_ARTIFACT_GRACE_MS,
	reapStaleNotificationArtifacts,
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

/**
 * The production seam set: real filesystem plus the no-follow capture and
 * identity-bound delete the reaper fences its removals with.
 */
function identityFencedFs(): TelegramDaemonFs {
	return {
		...(fs.promises as unknown as TelegramDaemonFs),
		readEndpointFile: readNotificationEndpointFile,
		exactUnlink: async (file, identity, quarantineName) =>
			exactUnlinkNotificationFile(
				file,
				identity,
				quarantineName ?? ".gjc-delete-notification-staging-temp-test.json",
			),
	};
}

function stagingTempFiles(dir: string): string[] {
	return fs.readdirSync(dir).filter(name => name.endsWith(".tmp"));
}

/** Reaper clock far enough ahead that the mtime grace window cannot retain a temp. */
function pastGraceWindow(): number {
	return Date.now() + NOTIFICATION_LEAK_ARTIFACT_GRACE_MS + 60_000;
}

/**
 * Create a crash-orphaned publication temp directly. A failed writer-owned
 * rename is no longer a valid fixture because writeJsonAtomic cleans its temp
 * after a pre-rename failure; a crash can still leave this staged file behind.
 */
async function leakOneStagingTemp(agentDir: string): Promise<void> {
	const paths = daemonPaths(agentDir);
	await fs.promises.mkdir(paths.dir, { recursive: true, mode: 0o700 });
	const tmp = `${paths.roots}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	await fs.promises.writeFile(tmp, "{}\n", { mode: 0o600 });
}

function agentDirWithNotifications(): string {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-staging-leak-"));
	fs.mkdirSync(daemonPaths(agentDir).dir, { recursive: true });
	return agentDir;
}

test("the notification reaper detaches dead-publisher staging temps without claiming terminal removal", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-staging-leak-"));
	const paths = daemonPaths(agentDir);

	for (let attempt = 0; attempt < 3; attempt++) await leakOneStagingTemp(agentDir);
	// Precondition: publication really did abandon its staged temps.
	expect(stagingTempFiles(paths.dir)).toHaveLength(3);

	// The temps name this very test process as publisher, so abandonment is only
	// provable once liveness reports that publisher dead.
	//
	// Advance the reaper's clock past the grace window rather than zeroing the
	// window: a temp written in the same millisecond can carry a fractional mtime
	// slightly ahead of an integer `Date.now()`, which reads as negative age and
	// is treated as still-staging.
	const result = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		now: pastGraceWindow,
		pidAlive: () => false,
	});

	expect(stagingTempFiles(paths.dir)).toEqual([]);
	expect(result.removed).toEqual([]);
	expect(result.skipped).toBe(3);
	expect(
		fs.readdirSync(paths.dir).filter(name => name.startsWith(".gjc-delete-notification-staging-temp-")),
	).toHaveLength(3);
});

test("the notification reaper leaves a staging temp younger than the grace window alone", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-staging-leak-"));
	const paths = daemonPaths(agentDir);

	await leakOneStagingTemp(agentDir);
	const [fresh] = stagingTempFiles(paths.dir);
	expect(fresh).toBeString();

	// A concurrent publication that is still staging its temp must never have it
	// reaped out from under the pending rename. Liveness is forced dead so the
	// retention proves the grace window, not the liveness fence.
	const result = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		pidAlive: () => false,
	});

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

	const result = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		graceMs: 0,
		pidAlive: () => false,
	});

	expect(fs.existsSync(paths.roots)).toBe(true);
	expect(fs.existsSync(decoy)).toBe(true);
	expect(result.removed).toEqual([]);
});

test("a staging temp whose publisher is still alive is never reaped, however old it is", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-staging-leak-"));
	const paths = daemonPaths(agentDir);

	await leakOneStagingTemp(agentDir);
	const [staged] = stagingTempFiles(paths.dir);
	expect(staged).toBeString();
	// The abandoned temp names this test process; the default liveness probe sees
	// it running, which is exactly the live-publisher case age alone misreads.

	const result = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		now: pastGraceWindow,
		graceMs: 0,
	});

	expect(stagingTempFiles(paths.dir)).toEqual([staged!]);
	expect(result.removed).toEqual([]);
	expect(result.skipped).toBeGreaterThan(0);
});

test("a staging temp is retained when publisher liveness is indeterminate", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-staging-leak-"));
	const paths = daemonPaths(agentDir);

	await leakOneStagingTemp(agentDir);
	const [staged] = stagingTempFiles(paths.dir);
	expect(staged).toBeString();

	// A probe that cannot answer (permission denied, unsupported platform) must
	// fail closed rather than degrade to age-only deletion.
	const result = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		now: pastGraceWindow,
		graceMs: 0,
		pidAlive: () => {
			throw new Error("EPERM: liveness probe denied");
		},
	});

	expect(stagingTempFiles(paths.dir)).toEqual([staged!]);
	expect(result.removed).toEqual([]);
	expect(result.skipped).toBeGreaterThan(0);
});

test("a staging temp with an unparseable publisher claim is retained", async () => {
	const agentDir = agentDirWithNotifications();
	const paths = daemonPaths(agentDir);
	// Staging-temp shape, but pid 0 is not a valid publisher, so no claim can be
	// proven dead and the temp must survive.
	const malformed = path.join(paths.dir, "telegram-daemon.roots.json.0.1700000000000.abc123.tmp");
	fs.writeFileSync(malformed, "{}\n");

	const result = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		now: pastGraceWindow,
		graceMs: 0,
		pidAlive: () => false,
	});

	expect(fs.existsSync(malformed)).toBe(true);
	expect(result.removed).toEqual([]);
	expect(result.skipped).toBeGreaterThan(0);
});

test("a dead publisher's staging temp stays retained under stable exact authority on POSIX", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-staging-leak-"));
	const paths = daemonPaths(agentDir);

	await leakOneStagingTemp(agentDir);
	const [staged] = stagingTempFiles(paths.dir);
	expect(staged).toBeString();
	const file = path.join(paths.dir, staged!);

	const result = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		fs: identityFencedFs(),
		now: pastGraceWindow,
		pidAlive: () => false,
	});

	expect(fs.existsSync(file)).toBe(false);
	expect(result.removed).toEqual([]);
	expect(result.skipped).toBeGreaterThan(0);
	const [detachedName] = fs
		.readdirSync(paths.dir)
		.filter(name => name.startsWith(".gjc-delete-notification-staging-temp-"));
	expect(detachedName).toBeString();
	const detachedPath = path.join(paths.dir, detachedName!);
	const retainedBytes = fs.readFileSync(detachedPath);

	const normalized = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		fs: identityFencedFs(),
		now: pastGraceWindow,
		graceMs: 0,
		pidAlive: () => false,
	});
	expect(normalized.removed).toEqual([]);
	expect(normalized.skipped).toBeGreaterThan(0);
	expect(fs.existsSync(detachedPath)).toBe(false);
	const placeholderNames = fs
		.readdirSync(paths.dir)
		.filter(name => name.startsWith(".gjc-exact-unlink-placeholder-"))
		.sort();
	const payloadPlaceholderName = placeholderNames.find(name => name.endsWith(".json"));
	expect(payloadPlaceholderName).toBeString();
	const payloadPlaceholderPath = path.join(paths.dir, payloadPlaceholderName!);
	expect(fs.readFileSync(payloadPlaceholderPath)).toEqual(retainedBytes);

	const stable = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		fs: identityFencedFs(),
		now: pastGraceWindow,
		graceMs: 0,
		pidAlive: () => false,
	});
	expect(stable.removed).toEqual([]);
	expect(stable.skipped).toBeGreaterThan(0);
	expect(
		fs
			.readdirSync(paths.dir)
			.filter(name => name.startsWith(".gjc-exact-unlink-placeholder-"))
			.sort(),
	).toEqual(placeholderNames);
	expect(fs.readFileSync(payloadPlaceholderPath)).toEqual(retainedBytes);
});

test("a staging temp replaced between identity capture and delete is not removed", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-staging-leak-"));
	const paths = daemonPaths(agentDir);

	await leakOneStagingTemp(agentDir);
	const [staged] = stagingTempFiles(paths.dir);
	expect(staged).toBeString();
	const file = path.join(paths.dir, staged!);

	const base = identityFencedFs();
	// ABA: the name is rewritten after the reaper captured its identity, so the
	// delete must bind the captured inode contents and refuse the successor.
	const racingFs: TelegramDaemonFs = {
		...base,
		readEndpointFile: async target => {
			const endpoint = await base.readEndpointFile!(target);
			if (target === file) fs.writeFileSync(file, "successor-staged-after-capture\n");
			return endpoint;
		},
	};

	const result = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		fs: racingFs,
		now: pastGraceWindow,
		pidAlive: () => false,
	});

	expect(result.removed).toEqual([]);
	expect(result.skipped).toBeGreaterThan(0);
	expect(fs.existsSync(file)).toBe(true);
	expect(fs.readFileSync(file, "utf8")).toBe("successor-staged-after-capture\n");
});
test("a retained staging quarantine replacement is not removed by the generic reaper", async () => {
	const agentDir = agentDirWithNotifications();
	const paths = daemonPaths(agentDir);
	const file = path.join(paths.dir, ".gjc-delete-notification-staging-temp-retained.json");
	fs.writeFileSync(file, "retained-original\n");

	const base = identityFencedFs();
	const racingFs: TelegramDaemonFs = {
		...base,
		readEndpointFile: async target => {
			const endpoint = await base.readEndpointFile!(target);
			if (target === file) fs.writeFileSync(file, "retained-successor\n");
			return endpoint;
		},
	};

	const result = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		fs: racingFs,
		now: pastGraceWindow,
		graceMs: 0,
		pidAlive: () => false,
	});

	expect(result.removed).toEqual([]);
	expect(result.skipped).toBeGreaterThan(0);
	expect(fs.readFileSync(file, "utf8")).toBe("retained-successor\n");
});

test("a retained cleanup_pending successor stays surfaced without pathname churn", async () => {
	const agentDir = agentDirWithNotifications();
	const paths = daemonPaths(agentDir);
	const file = path.join(paths.dir, ".gjc-delete-notification-staging-temp-retained.json");
	fs.writeFileSync(file, "retained-original\n");

	const base = identityFencedFs();
	let detachedPath: string | undefined;
	const retainingFs: TelegramDaemonFs = {
		...base,
		exactUnlink: async (target, _identity, quarantineName) => {
			if (!quarantineName) throw new Error("expected a retained quarantine name");
			detachedPath = path.join(path.dirname(target), quarantineName);
			fs.renameSync(target, detachedPath);
			return { ok: false, code: "cleanup_pending", detachedPath };
		},
	};

	const retained = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		fs: retainingFs,
		now: pastGraceWindow,
		graceMs: 0,
		pidAlive: () => false,
	});

	expect(retained.removed).toEqual([]);
	expect(retained.skipped).toBeGreaterThan(0);
	expect(fs.existsSync(file)).toBe(false);
	expect(detachedPath).toBeString();
	expect(path.basename(detachedPath!)).toStartWith(".gjc-exact-unlink-placeholder-");
	expect(fs.readFileSync(detachedPath!, "utf8")).toBe("retained-original\n");

	const healed = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		fs: base,
		now: pastGraceWindow,
		graceMs: 0,
		pidAlive: () => false,
	});

	expect(healed.removed).toEqual([]);
	expect(healed.skipped).toBeGreaterThan(0);
	expect(fs.existsSync(detachedPath!)).toBe(true);
	expect(fs.readFileSync(detachedPath!, "utf8")).toBe("retained-original\n");
	expect(
		fs
			.readdirSync(paths.dir)
			.filter(name => name.startsWith(".gjc-exact-unlink-placeholder-"))
			.map(name => path.join(paths.dir, name)),
	).toEqual([detachedPath!]);
});

test("a symlink shaped like a staging temp is never followed or deleted", async () => {
	const agentDir = agentDirWithNotifications();
	const paths = daemonPaths(agentDir);
	const victim = path.join(agentDir, "victim.json");
	fs.writeFileSync(victim, '{"keep":true}\n');
	const link = path.join(paths.dir, `telegram-daemon.roots.json.${process.pid + 1}.1700000000000.abc123.tmp`);
	fs.symlinkSync(victim, link);

	const result = await reapStaleNotificationArtifacts({
		settings: isolatedSettings(agentDir),
		fs: identityFencedFs(),
		now: pastGraceWindow,
		pidAlive: () => false,
	});

	// The no-follow capture rejects the link, so neither the link nor its target
	// is unlinked.
	expect(fs.existsSync(victim)).toBe(true);
	expect(fs.readFileSync(victim, "utf8")).toBe('{"keep":true}\n');
	expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
	expect(result.removed).toEqual([]);
	expect(result.skipped).toBeGreaterThan(0);
});
