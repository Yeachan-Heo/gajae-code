/**
 * Clean-subprocess probe for the production session-context budget semantics.
 *
 * Spawned by session-context-budget.test.ts with a scrubbed environment (no
 * GJC_SESSION_CONTEXT_BUDGET_BYTES), so the module-load-time resolution in
 * session-manager reflects the real production default rather than the 64 MiB
 * test-preload pin. Prints the resolved constant as JSON on stdout.
 */
import { SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES } from "../../src/session/session-manager";

console.log(JSON.stringify({ budgetBytes: SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES }));
