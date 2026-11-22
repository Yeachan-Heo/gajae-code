import type { DesktopAuthProvider, DesktopAuthState, DesktopModel } from "@gajae-code/desktop-host/protocol";
import { useState } from "react";
import { Button, Composer, Modal } from "./components";
import { type MessageKey, t } from "./i18n";
import { ProviderOnboardingNotice } from "./ProviderOnboardingNotice";
import { type ProviderKeyState, ProvidersPanel, ProvidersSummary } from "./ProvidersPanel";
import { normalizeApiKeyDraft, projectProviders, visibleFlow } from "./provider-status";

// Every id below is a design fixture; nothing here reaches the host, the SDK or a provider.
const fixtureProvider = (
	id: string,
	name: MessageKey | null,
	overrides: Partial<DesktopAuthProvider> = {},
): DesktopAuthProvider => ({
	id,
	name: name ? t(name) : id,
	configured: false,
	stored: false,
	credentialKinds: [],
	canSignIn: true,
	canStoreKey: true,
	...overrides,
});

function fixtureProviders(): DesktopAuthProvider[] {
	return [
		fixtureProvider("design-ready", "providers.showcaseNameReady", {
			configured: true,
			stored: true,
			credentialKinds: ["api_key"],
		}),
		fixtureProvider("design-subscription", "providers.showcaseNameSubscription", {
			configured: true,
			stored: true,
			credentialKinds: ["oauth"],
		}),
		fixtureProvider("design-local-gateway", "providers.showcaseNameGateway", { configured: true }),
		fixtureProvider("design-configured-outside", "providers.showcaseNameOutside", { configured: true }),
		fixtureProvider("design-korean-gateway", "providers.showcaseNameKorean"),
		fixtureProvider("design-key-only", null, { canSignIn: false }),
		fixtureProvider("design-browser-sign-in", "providers.showcaseNameBrowser", { canStoreKey: false }),
		fixtureProvider(
			"design-provider-with-a-deliberately-long-identifier-for-wrapping-checks",
			"providers.showcaseNameLong",
		),
		...Array.from({ length: 18 }, (_, index) => ({
			...fixtureProvider(`design-example-${String(index + 1).padStart(2, "0")}`, null),
			name: t("providers.showcaseNameNumbered", { index: String(index + 1).padStart(2, "0") }),
		})),
	];
}

const fixtureModels: DesktopModel[] = [
	...["alpha", "beta", "gamma"].map(id => ["design-ready", id]),
	["design-configured-outside", "delta"],
].map(([provider, id]) => ({
	id: `${provider}/${id}`,
	name: `Design ${id}`,
	provider: provider!,
	contextWindow: 128000,
	reasoning: false,
	thinking: { options: [] },
}));

const flowId = "DESIGN-ONLY-flow";
const flow = (provider: string, status: DesktopAuthState["status"], extra: Partial<DesktopAuthState> = {}) => ({
	id: flowId,
	provider,
	status,
	...extra,
});

interface FixtureState {
	label: MessageKey;
	group: "list" | "detail" | "flow";
	selected?: string;
	query?: string;
	loaded?: boolean;
	loadError?: boolean;
	disconnected?: boolean;
	busy?: boolean;
	flow?: DesktopAuthState;
	keyState?: ProviderKeyState;
}

function fixtureStates(): FixtureState[] {
	const signInUrl = "https://sign-in.example.invalid/oauth/authorize?client_id=design-only&state=fixture";
	const korean = "design-korean-gateway";
	return [
		{ label: "providers.showcaseStateLoading", group: "list", loaded: false },
		{ label: "providers.showcaseStateLoadError", group: "list", loaded: false, loadError: true },
		{ label: "providers.showcaseStateDisconnected", group: "list", disconnected: true },
		{
			label: "providers.showcaseStatePopulated",
			group: "list",
			flow: flow("design-browser-sign-in", "authorizing"),
		},
		{ label: "providers.showcaseStateNoMatch", group: "list", query: "no-such-provider" },
		{ label: "providers.showcaseStateKoreanSearch", group: "list", query: "게이트웨이" },
		{ label: "providers.showcaseStateBoth", group: "detail", selected: korean },
		{ label: "providers.showcaseStateKeyOnly", group: "detail", selected: "design-key-only" },
		{ label: "providers.showcaseStateConnected", group: "detail", selected: "design-ready" },
		{ label: "providers.showcaseStateExternal", group: "detail", selected: "design-local-gateway" },
		{ label: "providers.showcaseStateExternalModels", group: "detail", selected: "design-configured-outside" },
		{ label: "providers.showcaseStateStarting", group: "flow", selected: korean, flow: flow(korean, "authorizing") },
		{
			label: "providers.showcaseStateBrowser",
			group: "flow",
			selected: korean,
			flow: flow(korean, "authorizing", { url: signInUrl }),
		},
		{
			label: "providers.showcaseStateCode",
			group: "flow",
			selected: korean,
			flow: flow(korean, "waiting", {
				url: "https://sign-in.example.invalid/device",
				verificationCode: "WDJB-MJHT",
				instructions: "Verification code: WDJB-MJHT",
			}),
		},
		{
			label: "providers.showcaseStateInsecure",
			group: "flow",
			selected: korean,
			flow: flow(korean, "authorizing", { url: "http://sign-in.example.invalid/authorize" }),
		},
		{
			label: "providers.showcaseStatePrompt",
			group: "flow",
			selected: korean,
			flow: flow(korean, "waiting", {
				url: signInUrl,
				prompt: { id: "DESIGN-ONLY-prompt", message: t("providers.showcasePromptMessage") },
			}),
		},
		{
			label: "providers.showcaseStatePromptEmpty",
			group: "flow",
			selected: korean,
			flow: flow(korean, "waiting", {
				prompt: {
					id: "DESIGN-ONLY-prompt-empty",
					message: t("providers.showcasePromptEmptyMessage"),
					allowEmpty: true,
				},
			}),
		},
		{
			label: "providers.showcaseStateWarning",
			group: "flow",
			selected: korean,
			flow: flow(korean, "waiting", {
				warning: { id: "DESIGN-ONLY-warning", message: t("providers.showcaseWarningMessage") },
			}),
		},
		{
			label: "providers.showcaseStateFlowConnected",
			group: "flow",
			selected: "design-ready",
			flow: flow("design-ready", "complete"),
		},
		{
			label: "providers.showcaseStateFlowConnectedZero",
			group: "flow",
			selected: "design-subscription",
			flow: flow("design-subscription", "complete"),
		},
		{
			label: "providers.showcaseStateSavedRefresh",
			group: "flow",
			selected: "design-subscription",
			flow: flow("design-subscription", "error", {
				error: t("providers.showcaseSavedRefreshError"),
				catalogRefreshed: false,
			}),
		},
		{
			label: "providers.showcaseStateFailed",
			group: "flow",
			selected: korean,
			flow: flow(korean, "error", { error: t("providers.showcaseFlowError") }),
		},
		{ label: "providers.showcaseStateCancelled", group: "flow", selected: korean, flow: flow(korean, "cancelled") },
		{
			label: "providers.showcaseStateOtherFlow",
			group: "flow",
			selected: korean,
			flow: flow("design-browser-sign-in", "authorizing", { url: signInUrl }),
		},
		{
			label: "providers.showcaseStateKeySaving",
			group: "flow",
			selected: "design-key-only",
			busy: true,
			keyState: { provider: "design-key-only", status: "saving" },
		},
		{
			label: "providers.showcaseStateKeyError",
			group: "flow",
			selected: "design-key-only",
			keyState: { provider: "design-key-only", status: "error", error: t("providers.showcaseKeyError") },
		},
		{
			label: "providers.showcaseStateKeyCommand",
			group: "flow",
			selected: "design-key-only",
			keyState: { provider: "design-key-only", status: "invalid", reason: "command" },
		},
		{
			label: "providers.showcaseStateKeySaved",
			group: "flow",
			selected: "design-ready",
			keyState: { provider: "design-ready", status: "saved", catalogRefreshed: true },
		},
	];
}

const groupLabels: Record<FixtureState["group"], MessageKey> = {
	list: "providers.showcaseGroupList",
	detail: "providers.showcaseGroupDetail",
	flow: "providers.showcaseGroupFlow",
};

/** One panel instance with its own step, query and key state, reset whenever the fixture changes. */
function FixturePanel({ state, onLocal, onDone }: { state: FixtureState; onLocal(): void; onDone(): void }) {
	const [selected, setSelected] = useState<string | null>(state.selected ?? null);
	const [query, setQuery] = useState(state.query ?? "");
	const [keyState, setKeyState] = useState<ProviderKeyState | null>(state.keyState ?? null);
	const owned = new Set([flowId]);
	const shown = visibleFlow(state.flow ?? null, owned);
	return (
		<ProvidersPanel
			groups={projectProviders(state.loaded === false ? [] : fixtureProviders(), fixtureModels, shown, owned)}
			totalModels={fixtureModels.length}
			loaded={state.loaded !== false}
			loadError={state.loadError ? t("providers.loadFailed") : undefined}
			disconnected={!!state.disconnected}
			busy={!!state.busy}
			query={query}
			onQueryChange={setQuery}
			selected={selected}
			onSelect={setSelected}
			flow={shown}
			keyState={keyState}
			onRetryLoad={onLocal}
			onSignIn={onLocal}
			onAnswer={onLocal}
			onCancel={onLocal}
			onSaveKey={(provider, draft) => {
				const result = normalizeApiKeyDraft(draft);
				setKeyState(result.ok ? null : { provider, status: "invalid", reason: result.reason });
				onLocal();
			}}
			onOpenUrl={onLocal}
			onDone={onDone}
		/>
	);
}

function FixtureProvidersPanel() {
	const states = fixtureStates();
	const [state, setState] = useState<FixtureState>(states[3]!);
	const [notice, setNotice] = useState(t("providers.showcaseNoticeInitial"));
	const [dialog, setDialog] = useState(false);
	const local = () => setNotice(t("providers.showcaseNoticeLocal"));
	return (
		<>
			<p className="fixture-note muted">{t("providers.showcaseNote")}</p>
			{(["list", "detail", "flow"] as const).map(group => (
				<div className="actions" role="group" aria-label={t(groupLabels[group])} key={group}>
					<strong>{t(groupLabels[group])}</strong>
					{states
						.filter(item => item.group === group)
						.map(item => (
							<Button
								key={item.label}
								aria-pressed={state.label === item.label}
								onClick={() => {
									setState(item);
									setNotice(t("providers.showcaseNoticeSelected", { label: t(item.label) }));
								}}
							>
								{t(item.label)}
							</Button>
						))}
				</div>
			))}
			<p className="showcase-result" role="status">
				{notice}
			</p>
			<div className="actions">
				<Button onClick={() => setDialog(true)}>{t("providers.showcaseOpenDialog")}</Button>
			</div>
			<h3>{t("providers.showcaseWideHeading")}</h3>
			<div className="providers-showcase-frame">
				<FixturePanel key={`wide:${state.label}`} state={state} onLocal={local} onDone={local} />
			</div>
			<h3>{t("providers.showcaseNarrowHeading")}</h3>
			<div className="providers-showcase-frame" data-narrow="">
				<FixturePanel key={`narrow:${state.label}`} state={state} onLocal={local} onDone={local} />
			</div>
			<h3>{t("providers.showcaseSummaryHeading")}</h3>
			<div className="providers-showcase-frame">
				<ProvidersSummary models={fixtureModels} onManage={local} />
			</div>
			<div className="providers-showcase-frame">
				<ProvidersSummary models={[]} onManage={local} />
			</div>
			{dialog && (
				<Modal title={t("providers.dialogTitle")} className="providers-dialog" onClose={() => setDialog(false)}>
					<FixturePanel
						key={`dialog:${state.label}`}
						state={state}
						onLocal={local}
						onDone={() => {
							setDialog(false);
							local();
						}}
					/>
				</Modal>
			)}
		</>
	);
}

function FixtureOnboarding() {
	const [notice, setNotice] = useState(t("providers.showcaseNoticeInitial"));
	const connect = () => setNotice(t("providers.showcaseNoticeLocal"));
	return (
		<>
			<p className="fixture-note muted">{t("providers.showcaseOnboardingNote")}</p>
			<p className="showcase-result" role="status">
				{notice}
			</p>
			<h3>{t("providers.showcaseOnboardingDock")}</h3>
			<div className="providers-showcase-column">
				<div className="empty">
					<h2>{t("shell.selectConversation")}</h2>
					<Button disabled>{t("shell.chooseProjectFolder")}</Button>
				</div>
				<div className="provider-notice-dock">
					<ProviderOnboardingNotice onConnect={connect} />
				</div>
			</div>
			<h3>{t("providers.showcaseOnboardingComposer")}</h3>
			<div className="composer-area">
				<ProviderOnboardingNotice onConnect={connect} />
				<Composer value="" onChange={() => {}} onSend={connect} onStop={connect} busy={false} disabled />
			</div>
			<h3>{t("providers.showcaseOnboardingNarrow")}</h3>
			<div style={{ maxWidth: 390 }}>
				<ProviderOnboardingNotice onConnect={connect} />
			</div>
		</>
	);
}

/** Showcase index links for the providers dialog and onboarding notice sections. */
export function ProvidersShowcaseNav() {
	return (
		<>
			<a href="#showcase-providers">{t("providers.showcaseNavProviders")}</a>
			<a href="#showcase-provider-onboarding">{t("providers.showcaseNavOnboarding")}</a>
		</>
	);
}

/**
 * Showcase sections for the providers dialog and the onboarding notice. Each one is a
 * `<section id="showcase-…">` with an `<h2>` and a matching index link.
 */
export function ProvidersShowcase() {
	return (
		<>
			<section id="showcase-providers">
				<h2>{t("providers.showcaseHeading")}</h2>
				<FixtureProvidersPanel />
			</section>
			<section id="showcase-provider-onboarding">
				<h2>{t("providers.showcaseOnboardingHeading")}</h2>
				<FixtureOnboarding />
			</section>
		</>
	);
}
