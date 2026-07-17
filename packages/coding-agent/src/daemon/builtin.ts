/**
 * Static built-in daemon controller map.
 *
 * Controllers are deliberately static rather than a mutable plugin registry.
 */

import type { Settings } from "../config/settings";
import { type ChatDaemonControlDeps, ChatDaemonController } from "../sdk/bus/chat-daemon-control";
import { type TelegramDaemonControlDeps, TelegramDaemonController } from "../sdk/bus/telegram-daemon-control";
import type { BuiltInDaemonController, DaemonKind } from "./control-types";

export const BUILT_IN_DAEMON_KINDS = ["telegram", "discord", "slack"] as const satisfies readonly DaemonKind[];

export interface BuiltInDaemonControllerDeps {
	telegram?: TelegramDaemonControlDeps;
	discord?: ChatDaemonControlDeps;
	slack?: ChatDaemonControlDeps;
}

export function createBuiltInDaemonControllers(
	settings: Settings,
	deps: BuiltInDaemonControllerDeps = {},
): Record<DaemonKind, BuiltInDaemonController> {
	return {
		telegram: new TelegramDaemonController(settings, deps.telegram),
		discord: new ChatDaemonController(settings, "discord", deps.discord),
		slack: new ChatDaemonController(settings, "slack", deps.slack),
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
