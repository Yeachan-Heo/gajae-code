import type { DesktopMessageBlock } from "@gajae-code/desktop-host/protocol";
import { useState } from "react";
import { t } from "./i18n";
import { Markdown } from "./Markdown";

function MessageImage({ block }: { block: Extract<DesktopMessageBlock, { type: "image" }> }) {
	const [failedSource, setFailedSource] = useState<string>();
	const safeMime = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType);
	const safeData =
		typeof block.data === "string" && block.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(block.data);
	const source = `data:${block.mimeType};base64,${block.data}`;
	if (!safeMime || !safeData || failedSource === source)
		return <p className="message-image-unavailable">{t("support.imageUnavailable")}</p>;
	return (
		<figure className="message-image">
			<img src={source} alt={t("support.imageAlt")} onError={() => setFailedSource(source)} />
		</figure>
	);
}

/** Ordered message content; `tool` renders text as bounded output instead of prose. */
export function MessageBlocks({
	blocks,
	tool,
	markdown = false,
}: {
	blocks: DesktopMessageBlock[];
	tool: boolean;
	markdown?: boolean;
}) {
	return blocks.map((block, index) => {
		switch (block.type) {
			case "text":
				return block.text.trim() ? (
					tool ? (
						<pre className="bounded-output" key={index}>
							{block.text}
						</pre>
					) : (
						<div className="message-text" key={index}>
							{markdown ? <Markdown text={block.text} /> : block.text}
						</div>
					)
				) : null;
			case "thinking":
				return block.text.trim() ? (
					<details className="thinking-disclosure" key={index}>
						<summary>{t("support.reasoningSummary")}</summary>
						<div className="message-text">
							<Markdown text={block.text} />
						</div>
					</details>
				) : null;
			case "image":
				return <MessageImage key={index} block={block} />;
			case "image-unavailable":
				return (
					<p className="message-image-unavailable" key={index}>
						{t("support.imageUnavailableWithReason", { reason: block.reason })}
					</p>
				);
		}
		return null;
	});
}
