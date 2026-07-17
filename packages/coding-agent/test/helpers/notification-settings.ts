import { Settings } from "../../src/config/settings";
import { startFixtureBrokerWithLeaseForTest } from "../../src/sdk/broker/ensure";
import {
	cleanupFixtureRoot,
	cleanupFixtureRoots,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./fixture-broker-cleanup";

export function isolatedNotificationSettings(agentDir: string, overrides: Record<string, unknown> = {}): Settings {
	const settings = Settings.isolated(overrides as never);
	return new Proxy(settings, {
		get(target, property) {
			if (property === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

export async function createNotificationFixtureRoot(root: string, agentDir: string): Promise<FixtureRootCleanup> {
	const environment = createFixtureBrokerEnvironment(root, agentDir);
	const started = await withFixtureBrokerEnvironment(() =>
		startFixtureBrokerWithLeaseForTest({ agentDir, env: environment }),
	);
	return createFixtureRootCleanup(root, agentDir, started.lease);
}

export function registerNotificationRuntime(
	cleanup: FixtureRootCleanup,
	registration: { key: string; shutdown?: () => Promise<void>; dispose?: () => Promise<void> },
): void {
	registerFixtureRuntime(cleanup, { ...registration, requiredOwner: "runtime-and-broker" });
}

export type { FixtureRootCleanup };
export { cleanupFixtureRoot, cleanupFixtureRoots };
