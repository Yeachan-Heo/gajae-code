import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolDetail } from "@gajae-code/desktop-host/tool-protocol";
import { ChevronRight, CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "./i18n";
import { MessageBlocks } from "./MessageBlocks";
import { TodoToolBody } from "./TodoToolBody";
import { ToolSearchBody } from "./ToolSearchBody";

/** What a family-specific body receives inside an expanded tool card. */
export interface ToolCallBodyProps {
	message: DesktopMessage;
	/** The `tool.detail` result once it has loaded; absent before then and when unavailable. */
	detail?: DesktopToolDetail;
	/** The row's generic bounded output, for a body that has nothing better to show. */
	output: ReactNode;
}

/**
 * One `role: "tool"` transcript row: a native disclosure whose summary names the tool and its
 * state and whose body is the bounded output. `todo` and `tool-search` calls get their own body.
 */
export function ToolCallCard({ message }: { message: DesktopMessage }) {
	const blocks = message.blocks;
	const hasContent = blocks
		? blocks.some(block => block.type === "image" || block.type === "image-unavailable" || !!block.text.trim())
		: !!message.text.trim();
	const output = (
		<div className="tool-output">
			{hasContent ? (
				blocks ? (
					<MessageBlocks blocks={blocks} tool />
				) : (
					<pre className="bounded-output">{message.text}</pre>
				)
			) : (
				<pre className="bounded-output">{t("support.noOutput")}</pre>
			)}
		</div>
	);
	const Body =
		message.tool?.family === "todo"
			? TodoToolBody
			: message.tool?.family === "tool-search"
				? ToolSearchBody
				: undefined;
	return (
		<article className={`message ${message.role} ${message.isError ? "message-error" : ""}`}>
			<strong className="role-label">{t("support.roleTool")}</strong>
			{message.truncated && <small className="truncation-notice">{t("support.truncated")}</small>}
			<details className="tool-disclosure">
				<summary>
					<ChevronRight className="disclosure-chevron" aria-hidden="true" />
					<span className="tool-name">{message.toolName || t("support.toolFallback")}</span>
					{message.excludeFromContext && <small> · {t("support.excludedFromContext")}</small>}
					{message.cancelled ? (
						<small> · {t("support.cancelled")}</small>
					) : (
						message.isError && (
							<span className="tool-failure">
								<CircleAlert aria-hidden="true" /> · {t("support.failed")}
							</span>
						)
					)}
				</summary>
				{Body ? <Body message={message} output={output} /> : output}
			</details>
		</article>
	);
}
