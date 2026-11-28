import { useId } from "react";
import { t } from "./i18n";
import type { ToolCallBodyProps } from "./ToolCallCard";

/** Same folding as the Tools dialog search; kept local so the card does not import the dialog. */
function sameName(label: string, name: string): boolean {
	return label.normalize("NFKC").toLowerCase() === name.normalize("NFKC").toLowerCase();
}

/**
 * Expanded body of a tool-search card: the query, the tools the search turned on, and the
 * ranked matches. Until `tool.detail` has loaded a `toolSearch` section, it shows the generic
 * output unchanged; it never parses the tool's JSON text itself.
 */
export function ToolSearchBody({ detail, output }: ToolCallBodyProps) {
	const id = useId();
	const search = detail?.toolSearch;
	if (!search) return output;
	return (
		<div className="tool-search-body">
			<p className="tool-search-query">
				{t("catalog.searchQuery")} <code>{search.query}</code>
			</p>
			{search.activated.length > 0 && (
				<div className="tool-search-activated">
					<span id={`${id}-activated`}>{t("catalog.searchActivated")}</span>
					<ul aria-labelledby={`${id}-activated`}>
						{search.activated.map(name => (
							<li className="tool-search-chip" key={name}>
								{name}
							</li>
						))}
					</ul>
				</div>
			)}
			{search.matches.length === 0 ? (
				<p className="tool-search-empty">{t("catalog.searchNoMatches")}</p>
			) : (
				<>
					<ol className="tool-search-matches" aria-label={t("catalog.searchMatches")}>
						{search.matches.map(match => (
							<li className="tool-search-match" key={match.name}>
								<span className="tool-search-match-title">
									<strong>{match.label}</strong>
									{!sameName(match.label, match.name) && <code>{match.name}</code>}
									{match.mcpServer && (
										<span className="tool-catalog-tag">
											{t("catalog.tagMcp", { server: match.mcpServer })}
										</span>
									)}
								</span>
								{match.description && (
									<span className="tool-search-match-description" title={match.description}>
										{match.description}
									</span>
								)}
							</li>
						))}
					</ol>
					{search.total > search.matches.length && (
						<p className="tool-search-total">
							{t("catalog.searchTotal", { shown: search.matches.length, total: search.total })}
						</p>
					)}
				</>
			)}
		</div>
	);
}
