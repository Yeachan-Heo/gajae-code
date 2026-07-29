// Prints the resolved strict-mode bypass. NO_STRICT is a module-level constant,
// so the value has to be observed in a fresh process per scenario.
import { NO_STRICT } from "@gajae-code/ai/utils/schema/adapt";

console.log(JSON.stringify({ noStrict: NO_STRICT }));
