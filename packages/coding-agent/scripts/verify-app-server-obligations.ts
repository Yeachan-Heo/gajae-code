#!/usr/bin/env bun
export * from "../src/app-server/obligations-verifier";

import { main } from "../src/app-server/obligations-verifier";

if (import.meta.main) await main();
