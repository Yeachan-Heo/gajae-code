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

export async function stopIsolatedNotificationBroker(agentDir: string): Promise<void> {
	const brokerOwner = brokerOwnerForTest(agentDir);
	if (!brokerOwner) throw new Error(`Notification test broker owner was not retained for ${agentDir}.`);
	await brokerOwner.stop();
}
