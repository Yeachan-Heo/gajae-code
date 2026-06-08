export const HERMES_MCP_PROTOCOL_VERSION = "2024-11-05";
export const HERMES_MCP_SERVER_NAME = "gjc-hermes-mcp";

export const HERMES_MCP_TOOL_NAMES = [
	"gjc_hermes_list_sessions",
	"gjc_hermes_read_status",
	"gjc_hermes_read_tail",
	"gjc_hermes_list_questions",
	"gjc_hermes_list_artifacts",
	"gjc_hermes_read_artifact",
	"gjc_hermes_read_coordination_status",
	"gjc_hermes_start_session",
	"gjc_hermes_send_prompt",
	"gjc_hermes_submit_question_answer",
	"gjc_hermes_read_turn",
	"gjc_hermes_await_turn",
	"gjc_hermes_report_status",
] as const;

export type HermesToolName = (typeof HERMES_MCP_TOOL_NAMES)[number];
