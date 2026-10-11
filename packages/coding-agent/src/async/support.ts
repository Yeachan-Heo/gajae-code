import type { Settings } from "../config/settings";

export function isBackgroundJobSupportEnabled(settings: Pick<Settings, "get">): boolean {
	void settings;
	return true;
}
