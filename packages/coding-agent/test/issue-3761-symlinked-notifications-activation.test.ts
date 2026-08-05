/**
 * Regression for #3761: multi-account layouts symlink `notifications/` to a
 * shared directory. Native exact_unlink rejects intermediate directory reparse
 * points, so transition-lock release left `telegram-daemon.steal` behind and
 * setup failed with "provisional ownership could not be retired safely".
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tokenFingerprint } from "../src/sdk/bus/config";
import { daemonPaths } from "../src/sdk/bus/daemon-paths";
import {
	exactUnlinkNotificationFile,
	readNotificationEndpointFile,
} from "../src/sdk/bus/notification-service";
import {
	ensureTelegramDaemonRunningDetailed,
	readDaemonState,
} from "../src/sdk/bus/telegram-daemon";
import { createLightweightDaemonSettings } from "../src/sdk/bus/telegram-daemon-cli";

const BOT_TOKEN = "123456:AA-fake-token-for-issue-3761";
const CHAT_ID = "999001";

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		const state = (() => {
			try {
				const agentDir = path.join(root, "agent");
				const statePath = daemonPaths(agentDir).state;
				if (!fs.existsSync(statePath)) return undefined;
				return JSON.parse(fs.readFileSync(statePath, "utf8")) as { pid?: number };
			} catch {
				return undefined;
			}
		})();
		if (typeof state?.pid === "number" && state.pid > 0) {
			try {
				process.kill(state.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function sharedNotificationsAgent(): { root: string; agentDir: string; sharedDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-3761-"));
	tempRoots.push(root);
	const agentDir = path.join(root, "agent");
	const sharedDir = path.join(root, "shared-notifications");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(sharedDir, { recursive: true });
	fs.symlinkSync(sharedDir, path.join(agentDir, "notifications"));
	fs.writeFileSync(
		path.join(agentDir, "config.yml"),
		`notifications:
  enabled: true
  telegram:
    enabled: true
    botToken: "${BOT_TOKEN}"
    chatId: "${CHAT_ID}"
`,
	);
	return { root, agentDir, sharedDir };
}

function settingsFor(agentDir: string) {
	return createLightweightDaemonSettings({
		agentDir,
		rawConfig: {
			notifications: {
				enabled: true,
				telegram: {
					enabled: true,
					botToken: BOT_TOKEN,
					chatId: CHAT_ID,
				},
			},
		},
	});
}

describe("issue #3761 symlinked notifications activation", () => {
	test("exactUnlink through an intermediate notifications directory symlink succeeds", async () => {
		const { agentDir, sharedDir } = sharedNotificationsAgent();
		const viaAlias = path.join(agentDir, "notifications", "telegram-daemon.steal");
		const payload = `${JSON.stringify({ pid: process.pid, token: "hold" })}\n`;
		fs.writeFileSync(viaAlias, payload);

		const endpoint = await readNotificationEndpointFile(viaAlias);
		const result = exactUnlinkNotificationFile(
			viaAlias,
			endpoint.identity,
			`.gjc-delete-test-${crypto.randomUUID()}.json`,
		);
		expect(result.ok || result.code === "cleanup_pending").toBe(true);
		expect(fs.existsSync(viaAlias)).toBe(false);
		expect(fs.existsSync(path.join(sharedDir, "telegram-daemon.steal"))).toBe(false);
	});

	test("exactUnlink still refuses a final-component file symlink", async () => {
		const { agentDir } = sharedNotificationsAgent();
		const victim = path.join(agentDir, "victim.json");
		const alias = path.join(agentDir, "notifications", "alias-steal.json");
		fs.writeFileSync(victim, '{"keep":true}\n');
		fs.symlinkSync(victim, alias);

		const result = exactUnlinkNotificationFile(
			alias,
			{
				dev: 0n,
				ino: 0n,
				size: 0n,
				mtimeNs: 0n,
				sha256: "0".repeat(64),
			},
			`.gjc-delete-test-${crypto.randomUUID()}.json`,
		);
		expect(result).toEqual({ ok: false, code: "reparse_point" });
		expect(fs.existsSync(victim)).toBe(true);
		expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
	});

	test("ensureTelegramDaemonRunningDetailed becomes ready when notifications/ is a directory symlink", async () => {
		const { agentDir } = sharedNotificationsAgent();
		const settings = settingsFor(agentDir);
		const paths = daemonPaths(agentDir);

		const result = await ensureTelegramDaemonRunningDetailed({
			settings: settings as never,
			cwd: agentDir,
			sessionId: `notify-cli-${process.pid}`,
			registerRoot: false,
		});
		expect(result).toBe("spawned");

		const state = await readDaemonState(settings as never);
		expect(state).toMatchObject({
			ownershipPhase: "ready",
			chatId: CHAT_ID,
			tokenFingerprint: tokenFingerprint(BOT_TOKEN),
		});
		expect(fs.existsSync(paths.steal)).toBe(false);
		expect(fs.existsSync(paths.lock)).toBe(true);
	});
});
