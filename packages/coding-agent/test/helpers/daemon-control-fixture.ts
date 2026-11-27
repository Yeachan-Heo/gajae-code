import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../../src/config/settings";
import type { TrackedTempDirs } from "./tracked-temp-dirs";

export function tempAgentDir(trackedTemp: TrackedTempDirs): string {
	return trackedTemp.mkdtempSync(path.join(os.tmpdir(), "gjc-daemon-control-test-"));
}

export function setPrivateAgentDir(s: Settings, agentDir: string): Settings {
	return new Proxy(s, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}
