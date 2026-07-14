import { Settings } from "../../src/config/settings";
import type { SettingPath } from "../../src/config/settings-schema";
import { brokerOwnerForTest } from "../../src/sdk/broker/ensure";

/** Keep notification tests off the user's real config and daemon state. */
export function isolatedNotificationSettings(
	agentDir: string,
	overrides: Partial<Record<SettingPath, unknown>> = {},
): Settings {
	const settings = Settings.isolated({ "notifications.enabled": false, ...overrides });
	return new Proxy(settings, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
export type NotificationRuntimeShutdown = () => Promise<void>;

export async function stopIsolatedNotificationBroker(
	agentDir: string,
	options: { required?: boolean } = { required: true },
): Promise<void> {
	const brokerOwner = brokerOwnerForTest(agentDir);
	if (!brokerOwner) {
		if (options.required !== false)
			throw new Error(`Notification test broker owner was not retained for ${agentDir}.`);
		return;
	}
	await brokerOwner.stop();
}

export async function cleanupIsolatedNotificationRuntimes(
	shutdowns: NotificationRuntimeShutdown[],
	agentDirs: string[],
	requiredAgentDirs: Set<string>,
): Promise<void> {
	const errors: unknown[] = [];
	for (const shutdown of shutdowns.splice(0).reverse()) {
		try {
			await shutdown();
		} catch (error) {
			errors.push(error);
		}
	}
	for (const agentDir of agentDirs.splice(0)) {
		try {
			await stopIsolatedNotificationBroker(agentDir, { required: requiredAgentDirs.has(agentDir) });
		} catch (error) {
			errors.push(error);
		}
	}
	requiredAgentDirs.clear();
	if (errors.length > 0) throw new AggregateError(errors, "Notification runtime cleanup failed; preserving roots.");
}
