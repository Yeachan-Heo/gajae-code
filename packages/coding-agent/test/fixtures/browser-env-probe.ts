// Prints the browser launch overrides this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`:
// the env module parses `projectEnv` at load time from `process.cwd()`, so the
// trust boundary can only be exercised from a separate process.
import {
	resolveBrowserEnvOverridesForTest,
	resolveBrowserExecutableForTest,
} from "@gajae-code/coding-agent/tools/browser/launch";
import { defaultDiscoveryEnv } from "@gajae-code/coding-agent/tools/browser/profile-discovery";
import { createSessionChildEnvironment, type SessionLaunchEnvironment } from "../../src/sdk/session-environment";

const sessionEnvironment = process.env.GJC_TEST_SESSION_ENV
	? (JSON.parse(process.env.GJC_TEST_SESSION_ENV) as SessionLaunchEnvironment)
	: undefined;
const environment = createSessionChildEnvironment(sessionEnvironment);
const executablePath =
	process.env.GJC_TEST_RESOLVE_EXECUTABLE === "1"
		? await resolveBrowserExecutableForTest(sessionEnvironment, environment)
		: undefined;
const discovery = defaultDiscoveryEnv(() => false);
console.log(
	JSON.stringify({
		...resolveBrowserEnvOverridesForTest(sessionEnvironment, environment),
		...(executablePath === undefined ? {} : { resolvedExecutablePath: executablePath }),
		profileEnv: {
			localAppData: discovery.localAppData,
			chromeUserDataDir: discovery.chromeUserDataDir,
			chromeConfigHome: discovery.chromeConfigHome,
			xdgConfigHome: discovery.xdgConfigHome,
		},
	}),
);
