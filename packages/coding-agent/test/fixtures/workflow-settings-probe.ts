/**
 * Prints the resolved workflow setting for the current working directory.
 * Directory/env resolution happens at module load, so this must be a child
 * process when HOME/GJC_CONFIG_DIR/GJC_CODING_AGENT_DIR need isolation.
 */
import { resolveWorkflowSetting, type WorkflowSettingKey } from "../../src/gjc-runtime/workflow-settings";

const cwd = process.cwd();
const key = process.argv[2] as WorkflowSettingKey;
const result = await resolveWorkflowSetting(cwd, key, {
	defaultValue: "default",
	parse: (value: unknown) => ({ kind: "valid" as const, value }),
});
console.log(JSON.stringify({ value: result.value, source: result.source, diagnostics: result.diagnostics }));
