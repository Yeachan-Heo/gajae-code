import { getShellConfig, type ShellConfig } from "@gajae-code/utils/shell-config";
import type { ShellMinimizerSettings } from "../../src/config/settings-schema";

/**
 * The `Settings` surface `executeBash` requires from `ToolSession.settings`.
 *
 * `ToolSession.settings` is declared as a full `Settings`, and `BashTool`
 * threads it straight into `executeBash`, which resolves the shell, its
 * environment, and the configured prefix through `getShellConfig()` and reads
 * the output minimizer through `getGroup("shellMinimizer")`. A hand-rolled stub
 * that omits either member makes every real bash execution throw
 * (`settings.getShellConfig is not a function`) before a process is ever
 * spawned, so the test asserts nothing about the behavior it claims to cover.
 *
 * Spread this into a partial settings stub. `getShellConfig` mirrors
 * `Settings.getShellConfig()` for a stub that declares no `shellPath`; the
 * minimizer group is disabled, matching stubs whose `get()` returns `undefined`
 * for every `shellMinimizer.*` key.
 */
export const stubBashExecutorSettings: {
	getShellConfig: () => ShellConfig;
	getGroup: (prefix: "shellMinimizer") => ShellMinimizerSettings;
} = {
	getShellConfig: () => getShellConfig(),
	getGroup: () => ({
		enabled: false,
		settingsPath: undefined,
		settingsHash: undefined,
		only: [],
		except: [],
		maxCaptureBytes: 0,
	}),
};
