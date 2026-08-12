/**
 * Static built-in daemon controller map.
 *
 * Controllers are deliberately static rather than a mutable plugin registry.
 * The master controller is owned by the dedicated master module and is
 * adapted here to the common daemon control contract.
 */

import type { Settings } from "../config/settings";
import {
	MasterDaemonController,
	type MasterDaemonControllerDeps,
	type MasterDaemonOperationResult,
} from "../master/daemon-control";
import { type ChatDaemonControlDeps, ChatDaemonController } from "../sdk/bus/chat-daemon-control";
import { type TelegramDaemonControlDeps, TelegramDaemonController } from "../sdk/bus/telegram-daemon-control";
import type {
	BuiltInDaemonController,
	DaemonKind,
	DaemonOperationOptions,
	DaemonOperationResult,
} from "./control-types";

export const BUILT_IN_DAEMON_KINDS = [
	"telegram",
	"discord",
	"slack",
	"master",
] as const satisfies readonly DaemonKind[];

type MasterDaemonStop = (
	opts?: DaemonOperationOptions,
) => MasterDaemonOperationResult | DaemonOperationResult | Promise<MasterDaemonOperationResult | DaemonOperationResult>;
type MasterDaemonControllerInput = MasterDaemonControllerDeps & { stop?: MasterDaemonStop };

export interface BuiltInDaemonControllerDeps {
	telegram?: TelegramDaemonControlDeps;
	discord?: ChatDaemonControlDeps;
	slack?: ChatDaemonControlDeps;
	master?: MasterDaemonControllerInput;
}

function adaptMasterOperation(
	action: Exclude<DaemonOperationResult["action"], "list">,
	result: MasterDaemonOperationResult | DaemonOperationResult,
): DaemonOperationResult {
	const details = result as Partial<DaemonOperationResult>;
	return {
		kind: "master",
		action,
		ok: result.ok,
		warnings: [...result.warnings],
		message: result.message,
		...(details.before === undefined ? {} : { before: details.before }),
		...(details.after === undefined ? {} : { after: details.after }),
		...(details.recovery === undefined ? {} : { recovery: details.recovery }),
	};
}

/**
 * The dedicated master controller currently owns status/reload. Keep that
 * implementation as the runtime object (and therefore preserve its test
 * seams), while adapting operation results to the generic daemon contract.
 */
class BuiltInMasterDaemonController extends MasterDaemonController {
	readonly kind = "master" as const;
	readonly #stopOperation: MasterDaemonStop | undefined;

	constructor(deps: MasterDaemonControllerInput = {}) {
		const { stop, ...controllerDeps } = deps;
		super(controllerDeps);
		this.#stopOperation = stop;
	}

	async stop(opts?: DaemonOperationOptions): Promise<DaemonOperationResult> {
		if (this.#stopOperation !== undefined) return adaptMasterOperation("stop", await this.#stopOperation(opts));
		return adaptMasterOperation("stop", await super.stop(opts));
	}

	async reload(opts?: DaemonOperationOptions): Promise<DaemonOperationResult> {
		// Forward the operator's timeout/spawn options; dropping them made
		// `gjc daemon restart master --graceful-timeout-ms N` silently ignore N.
		return adaptMasterOperation("reload", await super.reload(opts));
	}
}

export function createBuiltInDaemonControllers(
	settings: Settings,
	deps: BuiltInDaemonControllerDeps = {},
): Record<DaemonKind, BuiltInDaemonController> {
	const master = new BuiltInMasterDaemonController(deps.master);
	return {
		telegram: new TelegramDaemonController(settings, deps.telegram),
		discord: new ChatDaemonController(settings, "discord", deps.discord),
		slack: new ChatDaemonController(settings, "slack", deps.slack),
		master: master as unknown as BuiltInDaemonController,
	};
}

/**
 * Resolve the controllers a command should act on. `--all` selects every
 * built-in kind in static declaration order; otherwise the explicit `kinds`
 * (defaulting to `telegram`).
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
