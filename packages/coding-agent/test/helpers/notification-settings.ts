import { Settings } from "../../src/config/settings";

/** Keep notification tests off the user's real config and daemon state. */
export function isolatedNotificationSettings(agentDir: string): Settings {
	const settings = Settings.isolated({ "notifications.enabled": false });
	return new Proxy(settings, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
