/**
 * `gjc daemon` command handler.
 *
 * Generic over the static built-in daemon controller map: lists/inspects
 * daemons and drives cooperative stop/reload. Telegram is the only kind today.
 */

import { Settings } from "../config/settings";
import { BUILT_IN_DAEMON_KINDS, selectDaemonControllers } from "../daemon/builtin";
import type {
	BuiltInDaemonController,
	DaemonKind,
	DaemonOperationOptions,
	DaemonOperationResult,
} from "../daemon/control-types";
import {
	DAEMON_ACTION_TOKENS,
	daemonOperationOutcome,
	formatDaemonResult,
	formatDaemonStatus,
	resolveDaemonAction,
} from "../daemon/operator-contract";
import { runChatDaemonInternal } from "../sdk/bus/chat-daemon-cli";
import { PublicCommandFailure, type PublicDaemonTargetOutcome } from "./public-command-errors";

export type DaemonCliAction = "list" | "status" | "stop" | "restart";
export type DaemonInternalCliAction = "discord-internal" | "slack-internal";
export type DaemonCommandAction = DaemonCliAction | DaemonInternalCliAction;

export class UnknownDaemonKindError extends PublicCommandFailure {
	constructor(
		readonly kinds: readonly string[],
		readonly knownKinds: readonly DaemonKind[],
	) {
		super({ kind: "operation_failed", proof: "pre-effect" });
		this.name = "UnknownDaemonKindError";
	}
}

export function isDaemonInternalAction(action: DaemonCommandAction): action is DaemonInternalCliAction {
	return action === "discord-internal" || action === "slack-internal";
}

export interface DaemonCommandArgs {
	action: DaemonCommandAction;
	kinds: DaemonKind[];
	all: boolean;
	json: boolean;
	force: boolean;
	gracefulTimeoutMs?: number;
	killTimeoutMs?: number;
	spawnIfStopped?: boolean;
	allowDisabledNoop?: boolean;
	smoke?: boolean;
	ownerId?: string;
	agentDir?: string;
	/** Show runtime detail and the full roots list in human output. */
	verbose?: boolean;
}

export interface DaemonCommandDeps {
	settings?: Settings;
	controllers?: BuiltInDaemonController[];
	/** Internal update orchestration retains result rendering and failure aggregation. */
	setExitCode?: (code: number) => void;
}

const INTERNAL_ACTIONS: DaemonInternalCliAction[] = ["discord-internal", "slack-internal"];
const KNOWN_KINDS = BUILT_IN_DAEMON_KINDS;

export function parseDaemonArgs(argv: string[]): DaemonCommandArgs | undefined {
	if (argv.length === 0 || argv[0] !== "daemon") return undefined;
	const rest = argv.slice(1);
	const actionToken = rest[0];
	const resolved = resolveDaemonAction(actionToken);
	const action = (resolved ??
		((INTERNAL_ACTIONS as readonly string[]).includes(actionToken ?? "")
			? actionToken
			: "status")) as DaemonCommandAction;
	const isActionToken =
		(DAEMON_ACTION_TOKENS as readonly string[]).includes(actionToken ?? "") ||
		(INTERNAL_ACTIONS as readonly string[]).includes(actionToken ?? "");
	const positional = isActionToken ? rest.slice(1) : rest;
	const kinds: DaemonKind[] = [];
	let all = false;
	let json = false;
	let force = false;
	let verbose = false;
	let gracefulTimeoutMs: number | undefined;
	let killTimeoutMs: number | undefined;
	let spawnIfStopped: boolean | undefined;
	let smoke = false;
	let ownerId: string | undefined;
	let agentDir: string | undefined;
	for (let i = 0; i < positional.length; i++) {
		const arg = positional[i];
		if (arg === "--all") all = true;
		else if (arg === "--json") json = true;
		else if (arg === "--force") force = true;
		else if (arg === "--verbose" || arg === "-v") verbose = true;
		else if (arg === "--spawn-if-stopped") spawnIfStopped = true;
		else if (arg === "--smoke") smoke = true;
		else if (arg === "--owner-id") ownerId = positional[++i];
		else if (arg === "--agent-dir") agentDir = positional[++i];
		else if (arg === "--graceful-timeout-ms") gracefulTimeoutMs = Number.parseInt(positional[++i], 10);
		else if (arg === "--kill-timeout-ms") killTimeoutMs = Number.parseInt(positional[++i], 10);
		else if (!arg.startsWith("--")) kinds.push(arg as DaemonKind);
	}
	return {
		action,
		kinds,
		all,
		json,
		force,
		verbose,
		gracefulTimeoutMs,
		killTimeoutMs,
		spawnIfStopped,
		smoke,
		ownerId,
		agentDir,
	};
}
export async function runDaemonCommand(cmd: DaemonCommandArgs, deps: DaemonCommandDeps = {}): Promise<void> {
	if (isDaemonInternalAction(cmd.action)) {
		const args = [
			...(cmd.smoke ? ["--smoke"] : []),
			...(cmd.ownerId ? ["--owner-id", cmd.ownerId] : []),
			...(cmd.agentDir ? ["--agent-dir", cmd.agentDir] : []),
		];
		await runChatDaemonInternal(cmd.action === "discord-internal" ? "discord" : "slack", args);
		return;
	}
	const unknownKinds = cmd.kinds.filter(kind => !(KNOWN_KINDS as readonly string[]).includes(kind));
	if (unknownKinds.length > 0) throw new UnknownDaemonKindError(unknownKinds, KNOWN_KINDS);
	let controllers: BuiltInDaemonController[];
	try {
		const settings = deps.settings ?? (await Settings.init());
		controllers = deps.controllers ?? selectDaemonControllers(settings, cmd.kinds, cmd.all);
	} catch {
		throw new PublicCommandFailure({ kind: "unavailable", proof: "pre-effect" });
	}

	if (cmd.action === "list" || cmd.action === "status") {
		const statuses = await Promise.all(
			controllers.map(async controller => {
				try {
					return await controller.status();
				} catch {
					throw new PublicCommandFailure({
						kind: "unavailable",
						proof: "pre-effect",
						daemonKind: controller.kind,
					});
				}
			}),
		);
		if (cmd.json) {
			process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
		} else {
			process.stdout.write(`${statuses.map(s => formatDaemonStatus(s, { verbose: cmd.verbose })).join("\n")}\n`);
		}
		return;
	}

	const opts: DaemonOperationOptions = {
		gracefulTimeoutMs: cmd.gracefulTimeoutMs,
		killTimeoutMs: cmd.killTimeoutMs,
		force: cmd.force,
		spawnIfStopped: cmd.spawnIfStopped,
		allowDisabledNoop: cmd.allowDisabledNoop,
	};
	const results: DaemonOperationResult[] = [];
	const targets: PublicDaemonTargetOutcome[] = [];
	for (const [index, controller] of controllers.entries()) {
		let result: DaemonOperationResult;
		try {
			result = cmd.action === "restart" ? await controller.reload(opts) : await controller.stop(opts);
		} catch {
			targets.push({ kind: controller.kind, outcome: "unknown" });
			for (const pending of controllers.slice(index + 1))
				targets.push({ kind: pending.kind, outcome: "not-applied" });
			throw new PublicCommandFailure({ kind: "daemon_mixed", targets });
		}
		results.push(result);
		targets.push({ kind: controller.kind, outcome: daemonOperationOutcome(result) });
	}
	const failed = results.some(result => !result.ok);
	if (failed && !deps.setExitCode) throw new PublicCommandFailure({ kind: "daemon_mixed", targets });
	if (cmd.json) {
		process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
	} else {
		process.stdout.write(`${results.map(formatDaemonResult).join("\n")}\n`);
	}
	if (failed) deps.setExitCode?.(1);
}
