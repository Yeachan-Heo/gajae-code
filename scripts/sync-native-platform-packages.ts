#!/usr/bin/env bun

import * as path from "node:path";
import { syncNativePlatformPackages } from "./native-platform-packages";

const repoRoot = path.join(import.meta.dir, "..");
const strict = process.argv.includes("--strict");

await syncNativePlatformPackages(repoRoot, { strict });
