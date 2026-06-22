/**
 * `gjc daemon` command handler.
 *
 * Generic over the static built-in daemon controller map: lists/inspects
 * daemons and drives cooperative stop/reload. Telegram is the only kind today.
 */

import { Settings } from "../config/settings";
import { selectDaemonControllers } from "../daemon/builtin";
import type {
	BuiltInDaemonController,
	DaemonKind,
	DaemonOperationOptions,
	DaemonOperationResult,
	DaemonStatus,
} from "../daemon/control-types";

export type DaemonCliAction = "list" | "status" | "stop" | "reload";

export interface DaemonCommandArgs {
	action: DaemonCliAction;
	kinds: DaemonKind[];
	all: boolean;
	json: boolean;
	force: boolean;
	gracefulTimeoutMs?: number;
	killTimeoutMs?: number;
	spawnIfStopped?: boolean;
}

export interface DaemonCommandDeps {
	settings?: Settings;
	controllers?: BuiltInDaemonController[];
}

const KNOWN_ACTIONS: DaemonCliAction[] = ["list", "status", "stop", "reload"];
const KNOWN_KINDS: DaemonKind[] = ["telegram"];

export function parseDaemonArgs(argv: string[]): DaemonCommandArgs | undefined {
	if (argv.length === 0 || argv[0] !== "daemon") return undefined;
	const rest = argv.slice(1);
	const action = (KNOWN_ACTIONS as string[]).includes(rest[0] ?? "") ? (rest[0] as DaemonCliAction) : "status";
	const positional = (KNOWN_ACTIONS as string[]).includes(rest[0] ?? "") ? rest.slice(1) : rest;
	const kinds: DaemonKind[] = [];
	let all = false;
	let json = false;
	let force = false;
	let gracefulTimeoutMs: number | undefined;
	let killTimeoutMs: number | undefined;
	let spawnIfStopped: boolean | undefined;
	for (let i = 0; i < positional.length; i++) {
		const arg = positional[i];
		if (arg === "--all") all = true;
		else if (arg === "--json") json = true;
		else if (arg === "--force") force = true;
		else if (arg === "--spawn-if-stopped") spawnIfStopped = true;
		else if (arg === "--graceful-timeout-ms") gracefulTimeoutMs = Number.parseInt(positional[++i], 10);
		else if (arg === "--kill-timeout-ms") killTimeoutMs = Number.parseInt(positional[++i], 10);
		else if (!arg.startsWith("--") && (KNOWN_KINDS as string[]).includes(arg)) kinds.push(arg as DaemonKind);
	}
	return { action, kinds, all, json, force, gracefulTimeoutMs, killTimeoutMs, spawnIfStopped };
}

function formatStatus(status: DaemonStatus): string {
	const parts = [
		`${status.kind}: ${status.health}`,
		status.configured ? undefined : "(not configured)",
		status.pid !== undefined ? `pid=${status.pid}` : undefined,
		status.ownerId ? `owner=${status.ownerId}` : undefined,
		status.rootCount !== undefined ? `roots=${status.rootCount}` : undefined,
		`mode=${status.runtime.mode}`,
	].filter(Boolean);
	let line = parts.join(" ");
	if (status.runtime.warning) line += `\n  warning: ${status.runtime.warning}`;
	return line;
}

function formatResult(result: DaemonOperationResult): string {
	const head = `${result.kind} ${result.action}: ${result.ok ? "ok" : "failed"} — ${result.message}`;
	const warnings = result.warnings.map(w => `\n  warning: ${w}`).join("");
	return head + warnings;
}

export async function runDaemonCommand(cmd: DaemonCommandArgs, deps: DaemonCommandDeps = {}): Promise<void> {
	const unknownKinds = cmd.kinds.filter(kind => !(KNOWN_KINDS as string[]).includes(kind));
	if (unknownKinds.length > 0) {
		process.stderr.write(
			`Unknown daemon kind(s): ${unknownKinds.join(", ")}. Known kinds: ${KNOWN_KINDS.join(", ")}.\n`,
		);
		process.exitCode = 1;
		return;
	}
	const settings = deps.settings ?? (await Settings.init());
	const controllers = deps.controllers ?? selectDaemonControllers(settings, cmd.kinds, cmd.all);

	if (cmd.action === "list" || cmd.action === "status") {
		const statuses = await Promise.all(controllers.map(c => c.status()));
		if (cmd.json) {
			process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
		} else {
			process.stdout.write(`${statuses.map(formatStatus).join("\n")}\n`);
		}
		return;
	}

	const opts: DaemonOperationOptions = {
		gracefulTimeoutMs: cmd.gracefulTimeoutMs,
		killTimeoutMs: cmd.killTimeoutMs,
		force: cmd.force,
		spawnIfStopped: cmd.spawnIfStopped,
	};
	const results: DaemonOperationResult[] = [];
	for (const controller of controllers) {
		results.push(cmd.action === "reload" ? await controller.reload(opts) : await controller.stop(opts));
	}
	if (cmd.json) {
		process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
	} else {
		process.stdout.write(`${results.map(formatResult).join("\n")}\n`);
	}
	if (results.some(r => !r.ok)) process.exitCode = 1;
}
