import type { DesktopAuthState } from "@gajae-code/desktop-host/protocol";
import { ChevronLeft, CircleCheck, LoaderCircle, Search, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { Button, ErrorBanner } from "./components";
import { type MessageKey, t } from "./i18n";
import {
	filterProviders,
	flowOutcome,
	isActiveFlow,
	type ProviderGroups,
	type ProviderRow,
	type ProviderStatus,
	safeAuthorizationUrl,
} from "./provider-status";

/**
 * The dialog's own key submission for one provider. `invalid` is a draft refused before any
 * request (see `normalizeApiKeyDraft`). The key itself is never kept.
 */
export type ProviderKeyState =
	| { provider: string; status: "invalid"; reason: "empty" | "command" }
	| { provider: string; status: "saving" }
	| { provider: string; status: "saved"; catalogRefreshed: boolean }
	| { provider: string; status: "error"; error: string };

export interface ProvidersPanelProps {
	groups: ProviderGroups;
	/** Every available model in the snapshot, for the list summary. */
	totalModels: number;
	/** The provider list has been read at least once. */
	loaded: boolean;
	loadError?: string;
	/** The Host is unreachable: every action is disabled. */
	disconnected: boolean;
	/** A request this dialog sent is still in flight. */
	busy: boolean;
	query: string;
	onQueryChange(query: string): void;
	/** The provider whose detail is open; null shows the list. */
	selected: string | null;
	onSelect(provider: string | null): void;
	/** The Host's flow as this dialog may show it: active, or finished and owned. */
	flow: DesktopAuthState | null;
	keyState?: ProviderKeyState | null;
	/** The last request's failure, shown in the step that sent it. */
	error?: string;
	/** The system browser is being asked to open the sign-in page. */
	opening?: boolean;
	/** Receives the search field so an owning dialog can focus it once its modal is shown. */
	searchRef?: RefObject<HTMLInputElement | null>;
	onRetryLoad(): void;
	onSignIn(provider: string): void;
	onAnswer(flowId: string, promptId: string, value: string): void;
	onCancel(flowId: string): void;
	/** Receives the raw draft; the owner validates it and the panel has already cleared the field. */
	onSaveKey(provider: string, draft: string): void;
	onOpenUrl(url: string): void;
	onDone(): void;
}

function counted(count: number, one: MessageKey, many: MessageKey): string {
	return count === 1 ? t(one) : t(many, { count });
}

const statusWords: Record<Exclude<ProviderStatus, "ready">, MessageKey> = {
	connecting: "providers.statusConnecting",
	failed: "providers.statusFailed",
	configured: "providers.statusConfigured",
	external: "providers.statusExternal",
	none: "providers.statusNone",
};

export function providerStatusLabel(row: ProviderRow): string {
	return row.status === "ready"
		? counted(row.models, "providers.statusReadyOne", "providers.statusReady")
		: t(statusWords[row.status]);
}

function StatusPill({ row }: { row: ProviderRow }) {
	return (
		<span className="provider-status" data-state={row.status}>
			{providerStatusLabel(row)}
		</span>
	);
}

function MethodTags({ row }: { row: ProviderRow }) {
	if (!row.canSignIn && !row.canStoreKey) return null;
	return (
		<span className="model-role-tags provider-methods">
			{row.canSignIn && <span className="model-role-tag">{t("providers.methodSignIn")}</span>}
			{row.canStoreKey && <span className="model-role-tag">{t("providers.methodKey")}</span>}
		</span>
	);
}

/** ArrowUp/ArrowDown/Home/End move between rows, as in the model picker; Enter is the button's own. */
function navigateRows(event: KeyboardEvent<HTMLDivElement>) {
	if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
	const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".provider-row:not(:disabled)")];
	const index = document.activeElement instanceof HTMLButtonElement ? rows.indexOf(document.activeElement) : -1;
	if (index < 0) return;
	event.preventDefault();
	const next =
		event.key === "Home"
			? 0
			: event.key === "End"
				? rows.length - 1
				: Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
	rows[next]?.focus();
	rows[next]?.scrollIntoView({ block: "nearest" });
}

function ProviderList(props: ProvidersPanelProps & { listRef: RefObject<HTMLDivElement | null> }) {
	const { groups, query } = props;
	const filtered = filterProviders(groups, query);
	const connectedCount = groups.connected.length;
	const total = groups.connected.length + groups.available.length;
	const summary = !props.loaded
		? props.disconnected
			? t("providers.hostRequired")
			: props.loadError
				? ""
				: t("providers.loading")
		: props.disconnected
			? t("providers.hostLost")
			: connectedCount > 0
				? `${t("providers.summaryConnected", { count: connectedCount })} · ${counted(props.totalModels, "providers.summaryModelsOne", "providers.summaryModels")}`
				: t("providers.summaryNone");
	const rowsDisabled = !props.loaded || props.disconnected;
	const group = (label: MessageKey, rows: ProviderRow[]) =>
		rows.length > 0 && (
			<section className="provider-group" aria-label={t(label)}>
				<h3 className="provider-group-heading">{t(label)}</h3>
				<ul className="provider-rows">
					{rows.map(row => (
						<li key={row.id}>
							<Button
								className="provider-row"
								data-provider-id={row.id}
								disabled={rowsDisabled}
								onClick={() => props.onSelect(row.id)}
							>
								<span className="provider-row-main">
									<strong>{row.name}</strong>
									{row.name !== row.id && <small className="provider-id">{row.id}</small>}
								</span>
								<span className="provider-row-meta">
									<StatusPill row={row} />
									<MethodTags row={row} />
								</span>
							</Button>
						</li>
					))}
				</ul>
			</section>
		);
	return (
		<>
			<div className="model-toolbar">
				<label className="model-search">
					<span className="sr-only">{t("providers.searchLabel")}</span>
					<Search size={16} aria-hidden="true" />
					<input
						ref={props.searchRef}
						value={query}
						placeholder={t("providers.searchPlaceholder")}
						autoComplete="off"
						spellCheck={false}
						onChange={event => props.onQueryChange(event.target.value)}
						onKeyDown={event => {
							if (event.key !== "ArrowDown") return;
							const first =
								props.listRef.current?.querySelector<HTMLButtonElement>(".provider-row:not(:disabled)");
							if (!first) return;
							event.preventDefault();
							first.focus();
						}}
					/>
				</label>
			</div>
			<p className="provider-summary" role="status">
				{summary}
			</p>
			{props.loadError && !props.loaded && (
				<div className="provider-load-error">
					<ErrorBanner>{props.loadError}</ErrorBanner>
					<Button disabled={props.disconnected} onClick={props.onRetryLoad}>
						{t("providers.retry")}
					</Button>
				</div>
			)}
			{props.loaded && (
				<div
					ref={props.listRef}
					className="provider-list"
					role="group"
					aria-label={t("providers.resultsLabel")}
					onKeyDown={navigateRows}
				>
					{total === 0 ? (
						<p className="provider-empty">{t("providers.noProviders")}</p>
					) : filtered.connected.length + filtered.available.length === 0 ? (
						<p className="provider-empty">{t("providers.noMatches")}</p>
					) : (
						<>
							{group("providers.groupConnected", filtered.connected)}
							{group("providers.groupAll", filtered.available)}
						</>
					)}
				</div>
			)}
			<p className="provider-footer">{t("providers.customEndpointsUnavailable")}</p>
		</>
	);
}

function FlowActions({ children }: { children: ReactNode }) {
	return <div className="provider-actions">{children}</div>;
}

/** The single authorization flow (or this dialog's key save) for the open provider. */
function FlowCard({
	row,
	flow,
	keySaved,
	locked,
	opening,
	onAnswer,
	onCancel,
	onOpenUrl,
	onSignIn,
	onBack,
	onDone,
}: {
	row: ProviderRow;
	flow: DesktopAuthState | null;
	/** Set when this dialog just saved a key for the provider. */
	keySaved?: { catalogRefreshed: boolean };
	locked: boolean;
	opening: boolean;
	onAnswer(flowId: string, promptId: string, value: string): void;
	onCancel(flowId: string): void;
	onOpenUrl(url: string): void;
	onSignIn(): void;
	onBack(): void;
	onDone(): void;
}) {
	const headingId = useId();
	const answerId = useId();
	const heading = useRef<HTMLHeadingElement>(null);
	const warningHeading = useRef<HTMLHeadingElement>(null);
	const answerInput = useRef<HTMLInputElement>(null);
	const [answer, setAnswer] = useState("");
	const outcome = flow
		? flowOutcome(flow)
		: keySaved?.catalogRefreshed === false
			? "saved-refresh-failed"
			: "connected";
	const active = outcome === "active";
	const waiting = flow?.status === "waiting";
	const prompt = active ? flow?.prompt : undefined;
	// The Host sends a warning only while the flow waits on it; Continue needs that waiting state.
	const warning = active && !prompt ? flow?.warning : undefined;
	const url = active ? safeAuthorizationUrl(flow?.url) : undefined;
	const insecure = active && !!flow?.url && !url;
	const code = active ? flow?.verificationCode : undefined;
	const view = warning ? "warning" : prompt ? "prompt" : url || insecure || code ? "browser" : outcome;
	const viewKey = `${flow?.id ?? "key"}:${view}:${prompt?.id ?? ""}:${warning?.id ?? ""}`;
	useEffect(() => {
		// The answer belongs to one prompt: a new prompt or flow starts empty.
		setAnswer("");
		if (view === "warning") warningHeading.current?.focus();
		else if (view === "prompt") answerInput.current?.focus();
		else heading.current?.focus();
	}, [viewKey]);
	const name = row.name;
	const headings: Record<string, string> = {
		warning: t("providers.flowWarningHeading"),
		prompt: t("providers.flowPromptHeading"),
		browser: t("providers.flowBrowserHeading"),
		active: t("providers.flowStartingHeading", { name }),
		connected: t("providers.flowConnectedHeading"),
		"saved-refresh-failed": t("providers.flowSavedHeading"),
		failed: t("providers.flowFailedHeading"),
		cancelled: t("providers.flowCancelledHeading"),
	};
	const statusLine =
		view === "warning"
			? t("providers.flowWarningStatus", { name })
			: view === "prompt"
				? t("providers.flowPromptStatus", { name })
				: view === "browser"
					? code
						? t("providers.flowCodeStatus")
						: t("providers.flowBrowserStatus")
					: view === "active"
						? t("providers.flowStartingStatus", { name })
						: view === "connected"
							? row.models > 0
								? counted(row.models, "providers.flowConnectedModelsOne", "providers.flowConnectedModels")
								: t("providers.flowConnectedNoModels")
							: view === "saved-refresh-failed"
								? t("providers.flowSavedNoRefresh")
								: view === "cancelled"
									? t("providers.flowCancelled")
									: "";
	const tone =
		view === "warning" || view === "saved-refresh-failed" || (view === "connected" && row.models === 0)
			? "waiting"
			: view === "connected"
				? "done"
				: view === "failed"
					? "error"
					: active
						? "running"
						: "muted";
	return (
		<section className="provider-flow" data-view={view} data-tone={tone} aria-labelledby={headingId}>
			<h4 id={headingId} ref={heading} tabIndex={-1} className="provider-flow-heading">
				{view === "connected" && row.models > 0 ? (
					<CircleCheck aria-hidden="true" />
				) : view === "connected" || view === "saved-refresh-failed" ? (
					<TriangleAlert aria-hidden="true" />
				) : active && view !== "warning" ? (
					<LoaderCircle aria-hidden="true" />
				) : null}
				{headings[view]}
			</h4>
			{statusLine && (
				<p className="provider-flow-status" role="status">
					{statusLine}
				</p>
			)}
			{view === "failed" && <ErrorBanner>{flow?.error || t("providers.flowFailed")}</ErrorBanner>}
			{code && (
				<div className="provider-code">
					<span>{t("providers.flowCodeLabel")}</span>
					<output className="provider-code-value">{code}</output>
				</div>
			)}
			{url && (
				<div className="provider-browser">
					<Button className="primary" disabled={locked || opening} onClick={() => onOpenUrl(url)}>
						{t("providers.flowOpen")}
					</Button>
					<p className="provider-url">
						<span className="sr-only">{t("providers.flowUrlLabel")} </span>
						{url}
					</p>
				</div>
			)}
			{insecure && <ErrorBanner>{t("providers.flowInsecureUrl")}</ErrorBanner>}
			{warning && flow && (
				<div className="provider-warning" role="group" aria-labelledby={`${headingId}-warning`}>
					<h5 id={`${headingId}-warning`} ref={warningHeading} tabIndex={-1}>
						<TriangleAlert aria-hidden="true" />
						{t("providers.flowWarningGroup", { name })}
					</h5>
					<p>{warning.message}</p>
					{waiting && (
						<FlowActions>
							<Button
								className="primary"
								disabled={locked}
								onClick={() => onAnswer(flow.id, warning.id, "confirm")}
							>
								{t("providers.flowContinue")}
							</Button>
							<Button disabled={locked} onClick={() => onCancel(flow.id)}>
								{t("providers.flowCancel")}
							</Button>
						</FlowActions>
					)}
				</div>
			)}
			{prompt && flow && (
				<form
					className="provider-prompt"
					onSubmit={event => {
						event.preventDefault();
						if (locked || (!prompt.allowEmpty && !answer)) return;
						const value = answer;
						setAnswer("");
						onAnswer(flow.id, prompt.id, value);
					}}
				>
					<label htmlFor={answerId}>{prompt.message}</label>
					<div className="provider-field-row">
						<input
							id={answerId}
							ref={answerInput}
							type="password"
							autoComplete="off"
							spellCheck={false}
							placeholder={prompt.placeholder}
							value={answer}
							disabled={locked}
							required={!prompt.allowEmpty}
							onChange={event => setAnswer(event.target.value)}
						/>
						<Button type="submit" className="primary" disabled={locked || (!prompt.allowEmpty && !answer)}>
							{t("providers.flowSubmit")}
						</Button>
					</div>
				</form>
			)}
			{active && !(warning && waiting) && flow && (
				<FlowActions>
					<Button disabled={locked} onClick={() => onCancel(flow.id)}>
						{t("providers.flowCancel")}
					</Button>
				</FlowActions>
			)}
			{(view === "connected" || view === "saved-refresh-failed") && (
				<FlowActions>
					<Button className="primary" onClick={onDone}>
						{t("providers.done")}
					</Button>
					<Button onClick={onBack}>{t("providers.backToProviders")}</Button>
				</FlowActions>
			)}
			{(view === "failed" || view === "cancelled") && (
				<FlowActions>
					<Button className="primary" disabled={locked || !row.canSignIn} onClick={onSignIn}>
						{t("providers.tryAgain")}
					</Button>
					<Button onClick={onBack}>{t("providers.backToProviders")}</Button>
				</FlowActions>
			)}
		</section>
	);
}

function ProviderDetail(
	props: ProvidersPanelProps & { row: ProviderRow; heading: RefObject<HTMLHeadingElement | null> },
) {
	const { row, flow, keyState } = props;
	const headingId = useId();
	const keyId = useId();
	const keyErrorId = useId();
	const [draft, setDraft] = useState("");
	const locked = props.disconnected || !props.loaded || props.busy;
	const ownFlow = flow?.provider === row.id ? flow : null;
	const otherFlow = flow && isActiveFlow(flow) && flow.provider !== row.id ? flow : null;
	const otherName =
		otherFlow &&
		([...props.groups.connected, ...props.groups.available].find(item => item.id === otherFlow.provider)?.name ??
			otherFlow.provider);
	const ownKey = keyState?.provider === row.id ? keyState : null;
	const invalid = ownKey?.status === "invalid" ? ownKey.reason : null;
	const keySaved = ownKey?.status === "saved" ? { catalogRefreshed: ownKey.catalogRefreshed } : undefined;
	const reconnect = row.credentialKinds.includes("oauth");
	const back = () => props.onSelect(null);
	return (
		<div className="provider-detail">
			<Button className="provider-back" onClick={back}>
				<ChevronLeft aria-hidden="true" />
				{t("providers.back")}
			</Button>
			<header className="provider-detail-head">
				<div className="provider-detail-title">
					<h3 id={headingId} ref={props.heading} tabIndex={-1}>
						{row.name}
					</h3>
					{row.name !== row.id && <small className="provider-id">{row.id}</small>}
				</div>
				<StatusPill row={row} />
			</header>
			{(row.connected || row.status === "external") && (
				<div className="provider-detail-note">
					{row.connected && (
						<p>
							{row.models > 0
								? counted(row.models, "providers.detailModelsOne", "providers.detailModels")
								: t("providers.detailNoModels")}
						</p>
					)}
					{row.status === "external" && <p>{t("providers.externalNote")}</p>}
					<p>{t("providers.sharedCredentials")}</p>
				</div>
			)}
			{props.error && <ErrorBanner>{props.error}</ErrorBanner>}
			{ownFlow || keySaved ? (
				<FlowCard
					key={ownFlow?.id ?? "key"}
					row={row}
					flow={ownFlow}
					keySaved={keySaved}
					locked={locked}
					opening={!!props.opening}
					onAnswer={props.onAnswer}
					onCancel={props.onCancel}
					onOpenUrl={props.onOpenUrl}
					onSignIn={() => props.onSignIn(row.id)}
					onBack={back}
					onDone={props.onDone}
				/>
			) : (
				<>
					{otherFlow && otherName && (
						<p className="provider-blocked" role="status">
							{t("providers.otherFlowActive", { name: otherName })}{" "}
							<Button className="provider-link" onClick={() => props.onSelect(otherFlow.provider)}>
								{t("providers.goToFlow", { name: otherName })}
							</Button>
						</p>
					)}
					{row.canSignIn && (
						<section className="provider-method" aria-labelledby={`${headingId}-sign-in`}>
							<h4 id={`${headingId}-sign-in`}>{t("providers.signInHeading")}</h4>
							<p className="provider-hint">{t("providers.signInHint")}</p>
							<div className="provider-actions">
								<Button
									className="primary"
									disabled={locked || !!otherFlow}
									onClick={() => props.onSignIn(row.id)}
								>
									{reconnect ? t("providers.reconnect") : t("providers.signIn")}
								</Button>
							</div>
						</section>
					)}
					{row.canStoreKey && (
						<form
							className="provider-method provider-key"
							aria-labelledby={`${headingId}-key`}
							noValidate
							onSubmit={event => {
								event.preventDefault();
								if (locked || otherFlow) return;
								const submitted = draft;
								// The secret never survives a submit, even a refused one.
								setDraft("");
								props.onSaveKey(row.id, submitted);
							}}
						>
							<h4 id={`${headingId}-key`}>
								{row.canSignIn ? t("providers.keyHeadingAlternative") : t("providers.keyHeading")}
							</h4>
							<p className="provider-hint">{t("providers.keyHint")}</p>
							<label htmlFor={keyId} className="sr-only">
								{t("providers.keyLabel", { name: row.name })}
							</label>
							<div className="provider-field-row">
								<input
									id={keyId}
									type="password"
									autoComplete="off"
									spellCheck={false}
									placeholder={t("providers.keyPlaceholder")}
									value={draft}
									disabled={props.disconnected}
									aria-invalid={invalid ? true : undefined}
									aria-describedby={invalid ? keyErrorId : undefined}
									onChange={event => setDraft(event.target.value)}
								/>
								<Button type="submit" disabled={locked || !!otherFlow || !draft}>
									{t("providers.saveKey")}
								</Button>
							</div>
							{invalid && (
								<p className="provider-field-error" id={keyErrorId} role="alert">
									{invalid === "empty" ? t("providers.keyEmpty") : t("providers.keyCommand")}
								</p>
							)}
							{ownKey?.status === "saving" && (
								<p className="provider-hint" role="status">
									{t("providers.savingKey")}
								</p>
							)}
							{ownKey?.status === "error" && <ErrorBanner>{ownKey.error}</ErrorBanner>}
						</form>
					)}
					{!row.canSignIn && !row.canStoreKey && <p className="provider-hint">{t("providers.noMethods")}</p>}
					{row.stored && (
						<div className="provider-disconnect">
							<Button disabled aria-describedby={`${headingId}-disconnect`}>
								{t("providers.disconnect")}
							</Button>
							<p className="provider-hint" id={`${headingId}-disconnect`}>
								{t("providers.disconnectUnavailable")}
							</p>
						</div>
					)}
				</>
			)}
		</div>
	);
}

/**
 * The providers dialog body: a searchable list and one provider's detail. It owns only drafts
 * and focus; the dialog (or a showcase fixture) owns the data, the step and every request.
 */
export function ProvidersPanel(props: ProvidersPanelProps) {
	const listRef = useRef<HTMLDivElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const searchFallback = useRef<HTMLInputElement>(null);
	const search = props.searchRef ?? searchFallback;
	const previous = useRef(props.selected);
	useEffect(() => {
		const from = previous.current;
		previous.current = props.selected;
		if (from === props.selected) return;
		if (props.selected) {
			// A flow card already moved focus to its own target (warning, prompt or heading).
			if (!heading.current?.closest(".provider-detail")?.querySelector(".provider-flow")) heading.current?.focus();
			return;
		}
		// Back returns to the row that opened the detail, or to search when it is filtered out.
		const row = from
			? [...(listRef.current?.querySelectorAll<HTMLButtonElement>(".provider-row") ?? [])].find(
					item => item.dataset.providerId === from,
				)
			: undefined;
		if (row && !row.disabled) {
			row.focus();
			row.scrollIntoView({ block: "nearest" });
		} else search.current?.focus();
	}, [props.selected, search]);
	const rows = [...props.groups.connected, ...props.groups.available];
	const selectedRow: ProviderRow | null = props.selected
		? (rows.find(row => row.id === props.selected) ?? {
				id: props.selected,
				name: props.selected,
				status: "none",
				models: 0,
				connected: false,
				configured: false,
				stored: false,
				credentialKinds: [],
				canSignIn: false,
				canStoreKey: false,
			})
		: null;
	return (
		<div className="providers-panel" data-step={selectedRow ? "detail" : "list"}>
			{selectedRow ? (
				<ProviderDetail key={selectedRow.id} {...props} row={selectedRow} heading={heading} />
			) : (
				<ProviderList {...props} searchRef={search} listRef={listRef} />
			)}
		</div>
	);
}
