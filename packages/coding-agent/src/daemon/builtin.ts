/**
 * Static built-in daemon controller map.
 *
 * Intentionally a static map keyed by daemon kind rather than a mutable plugin
 * registry: there is exactly one kind today (`telegram`). Promote to a richer
 * registry only when a second daemon kind exists.
 */

import type { Settings } from "../config/settings";
import { type TelegramDaemonControlDeps, TelegramDaemonController } from "../notifications/telegram-daemon-control";
import type { BuiltInDaemonController, DaemonKind } from "./control-types";

export const BUILT_IN_DAEMON_KINDS = ["telegram"] as const satisfies readonly DaemonKind[];

export interface BuiltInDaemonControllerDeps {
	telegram?: TelegramDaemonControlDeps;
}

export function createBuiltInDaemonControllers(
	settings: Settings,
	deps: BuiltInDaemonControllerDeps = {},
): Record<DaemonKind, BuiltInDaemonController> {
	return {
		telegram: new TelegramDaemonController(settings, deps.telegram),
	};
}

/**
 * Resolve the controllers a command should act on. `--all` selects every
 * built-in kind; otherwise the explicit `kinds` (defaulting to `telegram`).
 */
export function selectDaemonControllers(
	settings: Settings,
	kinds: DaemonKind[] | undefined,
	all: boolean,
	deps: BuiltInDaemonControllerDeps = {},
): BuiltInDaemonController[] {
	const map = createBuiltInDaemonControllers(settings, deps);
	if (all) return Object.values(map);
	const selected = kinds && kinds.length > 0 ? kinds : (["telegram"] as DaemonKind[]);
	return selected.map(kind => {
		const controller = map[kind];
		if (!controller) throw new Error(`unknown daemon kind: ${kind}`);
		return controller;
	});
}
