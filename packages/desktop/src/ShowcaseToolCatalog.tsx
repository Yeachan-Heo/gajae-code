import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolInfo, DesktopToolSearchDetail } from "@gajae-code/desktop-host/tool-protocol";
import { useState } from "react";
import { Button, Modal } from "./components";
import { t } from "./i18n";
import { ToolCallCard, ToolDetailContext, type ToolDetailSource } from "./ToolCallCard";
import { type ToolCatalog, ToolCatalogPanel, type ToolCatalogPanelProps } from "./ToolCatalogDialog";

/** Design-only tool rows. Labels and descriptions stand in for Host-issued tool metadata, which is not catalog copy. */
const fixtureTools: DesktopToolInfo[] = [
	{
		name: "read",
		label: "Read",
		description: "Read files, directories, archives, SQLite databases, images, documents and web URLs.",
		active: true,
		origin: "essential",
		discovered: false,
	},
	{
		name: "bash",
		label: "Bash",
		description: "Run a shell command in the workspace.",
		active: true,
		origin: "essential",
		discovered: false,
	},
	{
		name: "edit",
		label: "Edit",
		description: "Apply an edit to a file.",
		active: true,
		origin: "essential",
		discovered: false,
	},
	{
		name: "ast_grep",
		label: "AST Grep",
		description: "Search code with AST patterns (structural grep)",
		active: true,
		origin: "discoverable",
		discovered: true,
	},
	{
		name: "mcp_linear_create_issue",
		label: "linear/create_issue",
		description: "Create an issue in a Linear team.",
		active: true,
		origin: "discoverable",
		discovered: false,
		mcpServer: "linear",
	},
	{
		name: "todo_write",
		label: "Todo Write",
		description: "Write a structured todo list to track progress within a session",
		active: false,
		origin: "discoverable",
		discovered: false,
		hidden: true,
	},
	{
		name: "mcp_github_search_issues",
		label: "github/search_issues",
		description: "Search issues and pull requests across GitHub repositories.",
		active: false,
		origin: "discoverable",
		discovered: false,
		hidden: true,
		mcpServer: "github",
	},
	{
		name: "custom_release_notes",
		label: "custom_release_notes",
		description: "Draft release notes from merged pull requests.",
		active: false,
		origin: "other",
		discovered: false,
	},
];

const longTools: DesktopToolInfo[] = [
	{
		name: "mcp_enterprise_knowledge_base_semantic_document_retrieval_with_citations",
		label: "enterprise-knowledge-base/semantic_document_retrieval_with_citations",
		description:
			"Retrieve the passages that best answer a question from every indexed workspace, team wiki, design review and incident write-up, ranked by semantic similarity, with a citation for each passage so the agent can quote it back accurately and link to the source document…",
		active: false,
		origin: "discoverable",
		discovered: false,
		hidden: true,
		mcpServer: "enterprise-knowledge-base-production-eu-west-1",
	},
	{
		name: "render_mermaid",
		label: "Render Mermaid",
		description: "Render a Mermaid diagram to an image",
		active: true,
		origin: "discoverable",
		discovered: true,
	},
];

const koreanTools: DesktopToolInfo[] = [
	{
		name: "todo_write",
		label: "작업 목록",
		description: "세션 안에서 진행 상황을 추적할 수 있도록 단계별 작업 목록을 기록합니다.",
		active: false,
		origin: "discoverable",
		discovered: false,
		hidden: true,
	},
	{
		name: "mcp_notion_search",
		label: "notion/검색",
		description: "노션 워크스페이스에서 페이지와 데이터베이스를 검색합니다.",
		active: true,
		origin: "discoverable",
		discovered: false,
		mcpServer: "노션",
	},
	{
		name: "read",
		label: "Read",
		description: "파일, 디렉터리, 문서와 웹 URL을 읽습니다.",
		active: true,
		origin: "essential",
		discovered: false,
	},
];

function catalogOf(tools: DesktopToolInfo[], discovery: boolean | undefined = true): ToolCatalog {
	return {
		tools,
		active: tools.filter(tool => tool.active).map(tool => tool.name),
		...(discovery === undefined ? {} : { discovery: { enabled: discovery } }),
	};
}

type FixtureProps = Partial<Omit<ToolCatalogPanelProps, "edits" | "query">> & {
	edits?: Array<[string, boolean]>;
	query?: string;
};

/** One panel with local search and checkbox state; nothing is read from or saved to a Host. */
function FixtureCatalog({ edits: initialEdits = [], query: initialQuery = "", ...props }: FixtureProps) {
	const [query, setQuery] = useState(initialQuery);
	const [edits, setEdits] = useState<ReadonlyMap<string, boolean>>(new Map(initialEdits));
	const [notice, setNotice] = useState(props.notice ?? "");
	const catalog = props.catalog === undefined ? catalogOf(fixtureTools) : props.catalog;
	return (
		<ToolCatalogPanel
			reading={false}
			saving={false}
			onSave={() => {
				setEdits(new Map());
				setNotice(t("catalog.showcaseSaved"));
			}}
			{...props}
			catalog={catalog}
			notice={notice}
			query={query}
			onQueryChange={setQuery}
			edits={edits}
			onToggle={(name, checked) => {
				setNotice("");
				setEdits(previous => {
					const next = new Map(previous);
					if (catalog?.tools.find(tool => tool.name === name)?.active === checked) next.delete(name);
					else next.set(name, checked);
					return next;
				});
			}}
		/>
	);
}

const states: Array<{ id: string; title: () => string; props: FixtureProps; narrow?: boolean }> = [
	{ id: "loading", title: () => t("catalog.showcaseLoading"), props: { catalog: null, reading: true } },
	{
		id: "error",
		title: () => t("catalog.showcaseError"),
		props: { catalog: null, error: "Tool registry unavailable", onRetry: () => {} },
	},
	{ id: "populated", title: () => t("catalog.showcasePopulated"), props: { edits: [["todo_write", true]] } },
	{
		id: "long",
		title: () => t("catalog.showcaseLong"),
		props: { catalog: catalogOf(longTools) },
		narrow: true,
	},
	{
		id: "korean",
		title: () => t("catalog.showcaseKorean"),
		props: { catalog: catalogOf(koreanTools), query: "작업 목록" },
	},
	{ id: "no-matches", title: () => t("catalog.showcaseNoMatches"), props: { query: "없는 도구" } },
	{
		id: "running",
		title: () => t("catalog.showcaseRunning"),
		props: { edits: [["mcp_github_search_issues", true]], saveBlocked: "running" },
	},
	{
		id: "saving",
		title: () => t("catalog.showcaseSaving"),
		props: { edits: [["bash", false]], saving: true },
	},
	{
		id: "search-changed",
		title: () => t("catalog.showcaseSearchChanged"),
		props: { edits: [["edit", false]], searchChanged: true, onReload: () => {} },
	},
	{
		id: "discovery-off",
		title: () => t("catalog.showcaseDiscoveryOff"),
		props: {
			catalog: catalogOf(
				fixtureTools.map(tool => ({ ...tool, hidden: undefined, discovered: false })),
				false,
			),
		},
	},
	{
		id: "disconnected",
		title: () => t("catalog.showcaseDisconnected"),
		props: { edits: [["read", false]], saveBlocked: "disconnected" },
	},
	{ id: "unavailable", title: () => t("catalog.showcaseUnavailable"), props: { catalog: null, unavailable: true } },
	{ id: "empty", title: () => t("catalog.showcaseEmpty"), props: { catalog: catalogOf([]) } },
];

/** A settled tool-search row as the Host projects it; `activated` feeds the summary's fact. */
const searchMessage = (query: string, activated: string[]): DesktopMessage => ({
	id: "DESIGN-ONLY-tool-search",
	role: "tool",
	toolName: "search_tool_bm25",
	text: JSON.stringify({ query, activated_tools: activated, match_count: 4, total_tools: 31 }),
	tool: {
		callId: "DESIGN-ONLY-call",
		status: "done",
		family: "tool-search",
		subject: query,
		...(activated.length > 0 ? { stats: { activated } } : {}),
		detail: true,
	},
});

const populatedSearch: DesktopToolSearchDetail = {
	query: "todo list",
	activated: ["todo_write", "mcp_linear_create_issue"],
	matches: [
		{
			name: "todo_write",
			label: "Todo Write",
			description: "Write a structured todo list to track progress within a session",
		},
		{
			name: "mcp_linear_create_issue",
			label: "linear/create_issue",
			description:
				"Create an issue in a Linear team, with a title, a description, labels, an assignee and a due date.",
			mcpServer: "linear",
		},
		{
			name: "mcp_notion_search",
			label: "notion/검색",
			description: "노션 워크스페이스에서 할 일 목록이 있는 페이지와 데이터베이스를 검색합니다.",
			mcpServer: "노션",
		},
		{
			name: "checkpoint",
			label: "Checkpoint",
			description: "Create a git-based checkpoint to save and restore session state",
		},
	],
	total: 4,
};

const searchStates: Array<{ id: string; title: () => string; search?: DesktopToolSearchDetail }> = [
	{ id: "populated", title: () => t("catalog.showcaseSearchPopulated"), search: populatedSearch },
	{
		id: "capped",
		title: () => t("catalog.showcaseSearchCapped"),
		search: { ...populatedSearch, activated: [], total: 27 },
	},
	{
		id: "empty",
		title: () => t("catalog.showcaseSearchEmpty"),
		search: { query: "kubernetes rollout", activated: [], matches: [], total: 0 },
	},
	{ id: "fallback", title: () => t("catalog.showcaseSearchFallback") },
];

/** One local detail source per state, so a re-render never reloads the card. */
const searchSources = new Map<DesktopToolSearchDetail | undefined, ToolDetailSource>();
function searchSource(search: DesktopToolSearchDetail | undefined): ToolDetailSource {
	let source = searchSources.get(search);
	if (!source) {
		source = { load: async callId => ({ callId, ...(search ? { toolSearch: search } : {}) }) };
		searchSources.set(search, source);
	}
	return source;
}

/** Showcase index links for the tool catalog and tool search sections. */
export function ShowcaseToolCatalogNav() {
	return (
		<>
			<a href="#showcase-tool-catalog">{t("catalog.showcaseNavDialog")}</a>
			<a href="#showcase-tool-search">{t("catalog.showcaseNavSearch")}</a>
		</>
	);
}

/**
 * Showcase sections for the tool catalog and tool search. Each one is a
 * `<section id="showcase-…">` with an `<h2>` and a matching index link.
 */
export function ShowcaseToolCatalog() {
	return (
		<>
			<ShowcaseToolCatalogDialog />
			<section id="showcase-tool-search">
				<h2>{t("catalog.showcaseSearchHeading")}</h2>
				<p className="fixture-note muted">{t("catalog.showcaseSearchNote")}</p>
				{searchStates.map(state => (
					<div className="tool-catalog-showcase" id={`showcase-tool-search-${state.id}`} key={state.id}>
						<h3>{state.title()}</h3>
						{/* The real card, loading its details from a local source the way the app does. */}
						<ToolDetailContext.Provider value={searchSource(state.search)}>
							<ToolCallCard
								message={searchMessage(state.search?.query ?? "todo list", state.search?.activated ?? [])}
								defaultOpen
							/>
						</ToolDetailContext.Provider>
					</div>
				))}
			</section>
		</>
	);
}

/** Every Tools dialog state inline, plus the populated panel inside a real native dialog. */
function ShowcaseToolCatalogDialog() {
	const [open, setOpen] = useState(false);
	return (
		<section id="showcase-tool-catalog">
			<h2>{t("catalog.showcaseHeading")}</h2>
			<p className="fixture-note muted">{t("catalog.showcaseNote")}</p>
			<div className="actions">
				<Button onClick={() => setOpen(true)}>{t("catalog.showcaseOpen")}</Button>
			</div>
			{states.map(state => (
				<div className="tool-catalog-showcase" id={`showcase-tool-catalog-${state.id}`} key={state.id}>
					<h3>{state.title()}</h3>
					<div className={`tool-catalog-frame${state.narrow ? " tool-catalog-frame-narrow" : ""}`}>
						<FixtureCatalog {...state.props} />
					</div>
				</div>
			))}
			{open && (
				<Modal title={t("catalog.title")} onClose={() => setOpen(false)}>
					<FixtureCatalog />
				</Modal>
			)}
		</section>
	);
}
