import { isDoctorTargetId } from "./ids";
import type { DoctorMode, DoctorRepair, DoctorRiskClass, DoctorScope } from "./types";

export type DoctorAction =
	| "config.set-validated"
	| "mcp.set-startup-policy"
	| "permissions.restrict-owned-config"
	| "install.restore-binary"
	| "install.repair-managed-link"
	| "plugin.restore-known-artifact"
	| "plugin.quarantine-selected"
	| "service.restart-owned"
	| "service.detach-owned-stale-artifact";
export interface DoctorCliOptions {
	readonly mode: DoctorMode;
	readonly json: boolean;
	readonly help: boolean;
	readonly checks: readonly string[];
	readonly scope?: DoctorScope;
	readonly timeoutMs?: number;
	readonly repair?: DoctorAction;
	readonly targetId?: string;
	readonly setValue?: boolean;
	readonly ref?: string;
	readonly sha256?: string;
	readonly allowRisks: readonly DoctorRiskClass[];
	readonly yes: boolean;
	readonly drainSeconds?: number;
}
export type DoctorConfirmationResult = "confirmed" | "confirmation_declined" | "confirmation_timeout" | "cancelled";
export interface DoctorOptions extends DoctorCliOptions {
	readonly cwd?: string;
	readonly tty?: boolean;
	readonly signal?: AbortSignal;
	readonly runId?: string;
	readonly deadline?: number;
	/** Internal supervisor channel; never populated from CLI data. */
	readonly confirmRepair?: (repair: DoctorRepair) => Promise<DoctorConfirmationResult>;
	/** Synchronous notification before entering an effect-capable transaction. */
	readonly onRepairAdmitted?: () => void;
}
export interface DoctorParseResult {
	readonly options?: DoctorOptions;
	readonly error?: string;
}
const ACTION_TARGET_KINDS = {
	"config.set-validated": "config",
	"mcp.set-startup-policy": "mcp",
	"permissions.restrict-owned-config": "permission",
	"install.restore-binary": "binary",
	"install.repair-managed-link": "link",
	"plugin.restore-known-artifact": "plugin",
	"plugin.quarantine-selected": "plugin",
	"service.restart-owned": "service",
	"service.detach-owned-stale-artifact": "artifact",
} as const satisfies Record<DoctorAction, string>;
const ACTIONS = new Set(Object.keys(ACTION_TARGET_KINDS));
export function isDoctorAction(value: unknown): value is DoctorAction {
	return typeof value === "string" && ACTIONS.has(value);
}
const RISKS = new Set<DoctorRiskClass>([
	"config-change",
	"permission-change",
	"install-replace",
	"plugin-change",
	"service-interruption",
	"artifact-detach",
	"network",
	"external-execution",
]);
function value(argv: readonly string[], i: number, _flag: string): [string | undefined, number] {
	const v = argv[i + 1];
	return !v || v.startsWith("-") ? [undefined, i] : [v, i + 1];
}
export function parseDoctorArgs(argv: readonly string[]): DoctorParseResult {
	let mode: DoctorMode = "diagnose",
		json = false,
		help = false,
		scope: DoctorScope | undefined,
		timeoutMs: number | undefined;
	let repair: DoctorAction | undefined,
		targetId: string | undefined,
		setValue: boolean | undefined,
		ref: string | undefined,
		sha256: string | undefined,
		drainSeconds: number | undefined,
		yes = false;
	const checks = new Set<string>(),
		allowRisks = new Set<DoctorRiskClass>();
	const singleton = new Set([
		"--repair",
		"--target",
		"--set-value-json",
		"--ref",
		"--sha256",
		"--scope",
		"--timeout-ms",
	]);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--fix") {
			if (mode === "dry-run") continue;
			mode = "fix";
			continue;
		}
		if (arg === "--dry-run") {
			mode = "dry-run";
			continue;
		}
		if (arg === "--yes") {
			yes = true;
			continue;
		}
		const equals = arg.indexOf("=");
		const flag = equals < 0 ? arg : arg.slice(0, equals);
		const raw = equals < 0 ? undefined : arg.slice(equals + 1);
		const hasInline = raw !== undefined;
		if (flag === "--check" || flag === "--allow-risk") {
			const v = hasInline ? raw : value(argv, i, flag)[0];
			if (!v) return { error: `${flag} requires a value` };
			if (!hasInline) i++;
			if (flag === "--check") checks.add(v);
			else {
				if (!RISKS.has(v as DoctorRiskClass)) return { error: "unknown risk class" };
				allowRisks.add(v as DoctorRiskClass);
			}
			continue;
		}
		if (singleton.has(flag)) {
			if (
				(flag === "--repair" && repair) ||
				(flag === "--target" && targetId) ||
				(flag === "--set-value-json" && setValue !== undefined) ||
				(flag === "--ref" && ref) ||
				(flag === "--sha256" && sha256) ||
				(flag === "--scope" && scope) ||
				(flag === "--timeout-ms" && timeoutMs !== undefined)
			)
				return { error: `${flag} may be specified only once` };
			const v = hasInline ? raw : value(argv, i, flag)[0];
			if (!v) return { error: `${flag} requires a value` };
			if (!hasInline) i++;
			if (flag === "--repair") {
				if (!isDoctorAction(v)) return { error: "unknown repair action" };
				repair = v;
			} else if (flag === "--target") targetId = v;
			else if (flag === "--set-value-json") {
				if (v !== "true" && v !== "false") return { error: "--set-value-json accepts only true or false" };
				setValue = v === "true";
			} else if (flag === "--ref") ref = v;
			else if (flag === "--sha256") {
				if (!/^[a-fA-F0-9]{64}$/.test(v)) return { error: "--sha256 must be 64 hexadecimal characters" };
				sha256 = v.toLowerCase();
			} else if (flag === "--scope") {
				if (v !== "user" && v !== "project") return { error: "--scope must be user or project" };
				scope = v;
			} else {
				const n = Number(v);
				if (!Number.isInteger(n) || n < 1000 || n > 120000)
					return { error: "--timeout-ms must be an integer from 1000 to 120000" };
				timeoutMs = n;
			}
			continue;
		}
		if (arg === "--drain") {
			if (drainSeconds !== undefined) return { error: "--drain may be specified only once" };
			drainSeconds = 30;
			continue;
		}
		if (arg.startsWith("--")) return { error: "unknown option" };
		return { error: "unexpected argument" };
	}
	if (mode === "fix" && (!repair || !targetId)) return { error: "--fix requires --repair and --target" };
	if (mode === "dry-run" && repair !== undefined && targetId === undefined)
		return { error: "--repair requires --target" };
	if (drainSeconds !== undefined && repair !== "service.restart-owned")
		return { error: "--drain is only valid for service.restart-owned" };
	if (targetId !== undefined && !isDoctorTargetId(targetId))
		return { error: "target must be a stable doctor target ID" };
	if (repair && targetId && targetId.split(":")[1] !== ACTION_TARGET_KINDS[repair])
		return { error: "repair action does not match target kind" };
	if (scope && targetId) {
		const parts = targetId.split(":");
		const targetScope = parts.includes("user") ? "user" : parts.includes("project") ? "project" : undefined;
		if (!targetScope) return { error: "--scope is unsupported for this target" };
		if (targetScope !== scope) return { error: "--scope does not match target scope" };
	}
	if (repair === "config.set-validated" || repair === "mcp.set-startup-policy") {
		if (setValue === undefined) return { error: "this action requires --set-value-json true|false" };
	}
	if (repair !== "config.set-validated" && repair !== "mcp.set-startup-policy" && setValue !== undefined)
		return { error: "--set-value-json is only valid for config or MCP repairs" };
	if (repair !== "install.restore-binary" && repair !== "plugin.restore-known-artifact" && sha256 !== undefined)
		return { error: "--sha256 is only valid for binary or plugin restore" };
	if (
		repair !== "install.restore-binary" &&
		repair !== "plugin.restore-known-artifact" &&
		ref !== undefined &&
		repair !== "install.repair-managed-link"
	)
		return { error: "--ref is not valid for this repair" };
	if (repair === "install.repair-managed-link" && mode === "fix" && !ref)
		return { error: "install.repair-managed-link requires --ref" };
	if (
		repair === "install.repair-managed-link" &&
		ref !== undefined &&
		!/^c1:link:r[0-9a-f]{64}:(source|wrapper|binary):p[0-9a-f]{64}$/.test(ref)
	)
		return { error: "--ref must be a c1 link candidate ID" };
	return {
		options: {
			mode,
			json,
			help,
			checks: [...checks],
			scope,
			timeoutMs,
			repair,
			targetId,
			setValue,
			ref,
			sha256,
			allowRisks: [...allowRisks],
			yes,
			drainSeconds,
		},
	};
}
