import * as fs from "node:fs";
import * as path from "node:path";
import { isCompiledBinary } from "@gajae-code/utils/env";

export type BuildChannel = "release" | "dev" | "local-source" | "package-install" | "compiled" | "unknown";

export interface BuildMetadata {
	channel: BuildChannel;
	label: string;
}

const REPO_MARKERS = [".git", "bun.lock"];
const SOURCE_REPO_PACKAGE_NAME = "gajae-code";

export function resolveBuildMetadata(moduleDir: string = import.meta.dir): BuildMetadata {
	const explicitChannel = normalizeBuildChannel(process.env.GJC_BUILD_CHANNEL);
	if (explicitChannel) {
		return metadataForChannel(explicitChannel);
	}

	if (isCompiledBinary()) {
		return metadataForChannel("compiled");
	}

	if (isLocalSourceTree(moduleDir)) {
		return metadataForChannel("local-source");
	}

	return metadataForChannel("package-install");
}

export function formatBuildLabel(metadata: BuildMetadata = resolveBuildMetadata()): string {
	return metadata.label;
}

function normalizeBuildChannel(value: string | undefined): BuildChannel | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	switch (normalized) {
		case "release":
		case "stable":
			return "release";
		case "dev":
		case "development":
			return "dev";
		case "local-source":
		case "source":
		case "local":
			return "local-source";
		case "package-install":
		case "package":
		case "npm":
			return "package-install";
		case "compiled":
			return "compiled";
		case "unknown":
			return "unknown";
		default:
			return "unknown";
	}
}

function metadataForChannel(channel: BuildChannel): BuildMetadata {
	switch (channel) {
		case "release":
			return { channel, label: "release build" };
		case "dev":
			return { channel, label: "dev build" };
		case "local-source":
			return { channel, label: "local source" };
		case "package-install":
			return { channel, label: "package install" };
		case "compiled":
			return { channel, label: "compiled build" };
		case "unknown":
			return { channel, label: "build unknown" };
	}
}

function isLocalSourceTree(startDir: string): boolean {
	let current = path.resolve(startDir);
	while (true) {
		if (hasRepoMarkers(current)) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

function hasRepoMarkers(dir: string): boolean {
	if (!REPO_MARKERS.every(marker => fs.existsSync(path.join(dir, marker)))) return false;
	return readPackageName(path.join(dir, "package.json")) === SOURCE_REPO_PACKAGE_NAME;
}

function readPackageName(packageJsonPath: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) return undefined;
		const name = parsed.name;
		return typeof name === "string" ? name : undefined;
	} catch {
		return undefined;
	}
}
