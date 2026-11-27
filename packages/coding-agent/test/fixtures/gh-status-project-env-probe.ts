/**
 * Runs GJC's background `gh` callers from the current (project) directory the
 * way the app does: `@gajae-code/utils/env` loads first (copying the project
 * `.env` into the process environment), then the status line looks up the
 * branch's PR and the star reminder checks the star. `gh` is a PATH shim that
 * records the environment it received.
 */
import "@gajae-code/utils/env";
import { lookupCurrentPr } from "../../src/modes/components/status-line/gh";
import { checkGhStarred } from "../../src/reminders/star-reminder";

await lookupCurrentPr().catch(() => null);
await checkGhStarred().catch(() => null);
console.log(JSON.stringify({ done: true }));
process.exit(0);
