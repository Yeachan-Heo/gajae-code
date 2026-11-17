/**
 * Runs the recipe tool's runner detection from the current (project) directory
 * the way a session start does: `@gajae-code/utils/env` loads first (copying the
 * project `.env` into the process environment), then every runner probes its
 * program (`cargo metadata`, `just --dump`, `task --list-all`). The programs are
 * shims on PATH that record the environment they received.
 */
import "@gajae-code/utils/env";
import { RUNNERS } from "../../src/tools/recipe/runners";

await Promise.all(RUNNERS.map(runner => runner.detect(process.cwd()).catch(() => null)));
console.log(JSON.stringify({ done: true }));
process.exit(0);
