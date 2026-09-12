import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DoctorScope } from "./types";

export type RootKind = "config-user" | "config-project" | "agent" | "install";
export interface ResolvedRoot {
	readonly kind: RootKind;
	readonly locator: string;
	readonly rootId: string;
	readonly resolution: "resolved" | "resolution_unknown";
}

export function canonicalDigest(parts: readonly string[]): string {
	return createHash("sha256")
		.update(JSON.stringify(["gjc-doctor-logical-id-v1", ...parts]))
		.digest("hex");
}
function rootToken(rootId: string): string {
	if (!/^r[0-9a-f]{64}$/.test(rootId))
		throw new TypeError("rootId must be r followed by 64 lowercase hexadecimal characters");
	return rootId;
}
export function resolveDoctorRoot(kind: RootKind, locator: string): ResolvedRoot {
	const absolute = path.resolve(locator);
	let current = absolute;
	let resolution: ResolvedRoot["resolution"] = "resolved";
	const missing: string[] = [];
	try {
		while (true) {
			try {
				fs.lstatSync(current);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					resolution = "resolution_unknown";
					break;
				}
				const parent = path.dirname(current);
				if (parent === current) {
					resolution = "resolution_unknown";
					break;
				}
				missing.unshift(path.basename(current));
				current = parent;
			}
		}
		if (resolution === "resolved") current = path.join(fs.realpathSync.native(current), ...missing);
	} catch {
		resolution = "resolution_unknown";
	}
	const normalizedCurrent = process.platform === "win32" ? current.replaceAll("\\", "/").toLowerCase() : current;
	const normalizedAbsolute = process.platform === "win32" ? absolute.replaceAll("\\", "/").toLowerCase() : absolute;
	const normalized = resolution === "resolved" ? normalizedCurrent : normalizedAbsolute;
	return { kind, locator: normalized, rootId: `r${canonicalDigest([kind, normalized])}`, resolution };
}
export function configTargetId(rootId: string, scope: DoctorScope, schemaKey: string): string {
	if (schemaKey !== "skills.enabled" && schemaKey !== "skills.enableSkillCommands")
		throw new RangeError(`unsupported schema key: ${schemaKey}`);
	return `t1:config:${rootToken(rootId)}:${scope}:${schemaKey}`;
}
export function mcpTargetId(
	rootId: string,
	scope: DoctorScope,
	serverLogicalName: string,
	field: "autoload" | "enabled",
): string {
	return `t1:mcp:${rootToken(rootId)}:${scope}:n${canonicalDigest([serverLogicalName])}:${field}`;
}
export function permissionTargetId(rootId: string): string {
	return `t1:permission:${rootToken(rootId)}:user:config-yml`;
}
export function binaryTargetId(rootId: string, locator: string): string {
	return `t1:binary:${rootToken(rootId)}:standalone:p${canonicalDigest([locator])}`;
}
export function linkTargetId(rootId: string, linkName: string): string {
	return `t1:link:${rootToken(rootId)}:p${canonicalDigest([linkName])}`;
}
export function pluginTargetId(
	rootId: string,
	family: "gjc" | "npm" | "marketplace",
	scope: DoctorScope,
	name: string,
): string {
	return `t1:plugin:${rootToken(rootId)}:${family}:${scope}:n${canonicalDigest([name])}`;
}
export function serviceTargetId(rootId: string, service: "broker" | "telegram" | "discord" | "slack"): string {
	return `t1:service:${rootToken(rootId)}:${service}`;
}
export function artifactTargetId(
	rootId: string,
	service: "broker" | "telegram" | "discord" | "slack",
	slot: "discovery" | "owner-lock" | "startup-marker",
): string {
	return `t1:artifact:${rootToken(rootId)}:${service}:${slot}`;
}
export function candidateLinkId(rootId: string, kind: "source" | "wrapper" | "binary", locator: string): string {
	return `c1:link:${rootToken(rootId)}:${kind}:p${canonicalDigest([locator])}`;
}
export function isDoctorTargetId(value: string): boolean {
	const digest = "[0-9a-f]{64}";
	const root = `r${digest}`;
	return (
		new RegExp(`^t1:config:${root}:(user|project):(skills\\.(enabled|enableSkillCommands))$`).test(value) ||
		new RegExp(`^t1:mcp:${root}:(user|project):n${digest}:(autoload|enabled)$`).test(value) ||
		new RegExp(`^t1:permission:${root}:user:config-yml$`).test(value) ||
		new RegExp(`^t1:binary:${root}:standalone:p${digest}$`).test(value) ||
		new RegExp(`^t1:link:${root}:p${digest}$`).test(value) ||
		new RegExp(`^t1:plugin:${root}:(gjc|npm|marketplace):(user|project):n${digest}$`).test(value) ||
		new RegExp(`^t1:service:${root}:(broker|telegram|discord|slack)$`).test(value) ||
		new RegExp(`^t1:artifact:${root}:(broker|telegram|discord|slack):(discovery|owner-lock|startup-marker)$`).test(
			value,
		)
	);
}
