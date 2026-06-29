#!/usr/bin/env bun

import * as path from "node:path";
import { nativePlatformPackages } from "./native-platform-packages";

const packageDir = process.cwd();
const manifest = (await Bun.file(path.join(packageDir, "package.json")).json()) as { name?: string };
const platformPackage = manifest.name
	? nativePlatformPackages.find(entry => entry.packageName === manifest.name)
	: undefined;

if (!platformPackage) {
	throw new Error(`Unknown native platform package: ${manifest.name ?? "(missing name)"}`);
}

const nativeDir = path.join(packageDir, "native");
const present: string[] = [];
for (const filename of platformPackage.files) {
	if (await Bun.file(path.join(nativeDir, filename)).exists()) present.push(filename);
}

if (present.length === 0) {
	throw new Error(
		`${platformPackage.packageName} has no native addon payload. Expected one of: ${platformPackage.files.join(", ")}`,
	);
}

console.log(`${platformPackage.packageName}: ${present.join(", ")}`);
