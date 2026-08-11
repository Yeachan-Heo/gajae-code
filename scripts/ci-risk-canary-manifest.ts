/**
 * Promotion procedure: when a post-merge Dev CI failure exposes an indirect
 * contract that presubmit missed, add or extend a RiskClass entry here. Widen
 * its match, append the implicated test to canaries, and set promotedFrom to
 * the Dev CI run id or issue. Promotion is a manifest edit, never workflow
 * prose, and the bounded MAX_CANARY_TESTS cap must stay satisfied.
 * All matches are path-component or delimiter bounded so a promotion cannot
 * silently widen to unrelated packages.
 */

export type RiskClassId =
	| "process-lifecycle"
	| "filesystem-migration"
	| "global-env-config"
	| "session-sdk-notifications"
	| "test-fixture-helper"
	| "ci-planner-manifest";

export interface RiskClassMatch {
	readonly prefixes?: readonly string[];
	readonly suffixes?: readonly string[];
	readonly segments?: readonly string[];
	readonly exact?: readonly string[];
}

export interface RiskClass {
	readonly id: RiskClassId;
	readonly description: string;
	readonly match: RiskClassMatch;
	readonly canaries: readonly string[];
	readonly promotedFrom?: string;
}

export const RISK_CLASSES: readonly RiskClass[] = [
	{
		id: "process-lifecycle",
		description: "process, WebSocket, and server lifecycle plus fixture readiness.",
		match: {
			prefixes: ["packages/coding-agent/src/sdk/broker/"],
			segments: ["websocket", "daemon-control"],
			exact: ["crates/pi-shell/src/process.rs"],
			suffixes: ["/process.ts", "-daemon.ts"],
		},
		canaries: ["packages/coding-agent/test/sdk-broker-restart.test.ts"],
	},
	{
		id: "filesystem-migration",
		description: "temporary-directory, filesystem migration, and GC contention.",
		match: {
			segments: ["migrate", "tmpdir"],
			prefixes: ["packages/coding-agent/src/gc/", "packages/coding-agent/src/storage/"],
		},
		canaries: ["packages/coding-agent/test/gc-runtime.test.ts"],
	},
	{
		id: "global-env-config",
		description: "ambient cwd, environment, and agent/config-root state.",
		match: {
			prefixes: ["packages/coding-agent/src/config/"],
			segments: ["agent-dir", "config-root"],
			exact: ["packages/coding-agent/src/paths.ts"],
		},
		canaries: ["packages/coding-agent/test/config-cli.test.ts"],
	},
	{
		id: "session-sdk-notifications",
		description: "session manager, SDK broker, notification, TUI, and runtime lifecycle coupling.",
		match: {
			prefixes: [
				"packages/coding-agent/src/session/",
				"packages/coding-agent/src/sdk/",
				"packages/coding-agent/src/tui/",
			],
			segments: ["session-manager", "notifications"],
		},
		canaries: [
			"packages/coding-agent/test/notifications-live-stream.test.ts",
			"packages/coding-agent/test/session-manager-resident-cache.test.ts",
		],
		promotedFrom: "dev-ci run 30309767471",
	},
	{
		id: "test-fixture-helper",
		description: "shared test fixtures and helpers whose contract changes ripple into unrelated suites.",
		match: {
			prefixes: ["packages/coding-agent/test/fixtures/", "packages/coding-agent/test/helpers/"],
			exact: ["packages/coding-agent/src/test-helpers.ts"],
			suffixes: ["/helpers.ts", "/fixture.ts"],
		},
		canaries: ["packages/coding-agent/test/fixture-broker-cleanup.test.ts"],
	},
	{
		id: "ci-planner-manifest",
		description: "CI planner, manifest, and affected-plan contract changes.",
		match: {
			exact: ["scripts/ci-dev-affected.ts", "scripts/ci-risk-canary-manifest.ts", "scripts/ci-virtual-integration.ts"],
		},
		canaries: ["scripts/ci-virtual-integration.test.ts"],
	},
];

export const MAX_CANARY_TESTS = 8;

function basenameWithoutExtension(segment: string): string {
	const extensionIndex = segment.lastIndexOf(".");
	return extensionIndex > 0 ? segment.slice(0, extensionIndex) : segment;
}

export function matchesRiskClass(changedPath: string, riskClass: RiskClass): boolean {
	const pathSegments = changedPath.split("/");
	const { exact, prefixes, suffixes, segments } = riskClass.match;
	if (exact?.some(path => path === changedPath)) return true;
	if (prefixes?.some(prefix => changedPath === prefix || (prefix.endsWith("/") ? changedPath.startsWith(prefix) : changedPath.startsWith(`${prefix}/`)))) return true;
	if (suffixes?.some(suffix => changedPath.endsWith(suffix))) return true;
	if (segments?.some(segment => pathSegments.some(pathSegment => pathSegment === segment || basenameWithoutExtension(pathSegment) === segment))) return true;
	return false;
}

export function classifyRiskClasses(paths: readonly string[]): RiskClassId[] {
	return RISK_CLASSES.filter(riskClass => paths.some(path => matchesRiskClass(path, riskClass))).map(riskClass => riskClass.id);
}

export function selectCanaryTestsFrom(paths: readonly string[], riskClasses: readonly RiskClass[]): string[] {
	const selected = new Set<string>();
	for (const riskClass of riskClasses) {
		if (!paths.some(path => matchesRiskClass(path, riskClass))) continue;
		for (const canary of riskClass.canaries) {
			selected.add(canary);
			if (selected.size > MAX_CANARY_TESTS) {
				throw new Error(`Selected canary tests exceed MAX_CANARY_TESTS (${MAX_CANARY_TESTS})`);
			}
		}
	}
	return [...selected];
}

export function selectCanaryTests(paths: readonly string[]): string[] {
	return selectCanaryTestsFrom(paths, RISK_CLASSES);
}
