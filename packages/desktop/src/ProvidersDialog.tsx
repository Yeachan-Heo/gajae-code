import type {
	DesktopAuthProvider,
	DesktopAuthState,
	DesktopCredentialSaveResult,
	DesktopModel,
} from "@gajae-code/desktop-host/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { openExternalUrl, request, subscribe } from "./bridge";
import { Modal } from "./components";
import { t } from "./i18n";
import { type ProviderKeyState, ProvidersPanel } from "./ProvidersPanel";
import { isActiveFlow, modelCounts, normalizeApiKeyDraft, projectProviders, visibleFlow } from "./provider-status";

export interface ProvidersDialogProps {
	connected: boolean;
	/** `snapshot.models`: the available models, counted per provider. */
	models: readonly DesktopModel[];
	onClose(): void;
}

function failureMessage(failure: unknown, fallback: string): string {
	return failure instanceof Error && failure.message ? failure.message : fallback;
}

/**
 * The Host's single authorization flow as one mounted dialog sees it.
 *
 * On open it reads `auth.state` once: an active flow is resumed (and owned), a finished one is
 * history. Only owned flows may report success or failure. `generation` retires every read and
 * request from a previous connection, `revision` lets a newer `auth` frame win over a slower
 * response, and `locked` admits one request at a time. Closing never cancels a flow.
 */
function useProviderAuthorization(connected: boolean, models: readonly DesktopModel[]) {
	const [providers, setProviders] = useState<DesktopAuthProvider[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState("");
	const [ready, setReady] = useState(false);
	const [auth, setAuth] = useState<DesktopAuthState | null>(null);
	const [owned, setOwned] = useState<ReadonlySet<string>>(() => new Set());
	const [busy, setBusy] = useState(false);
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState("");
	const [keyState, setKeyState] = useState<ProviderKeyState | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	const [providersRevision, setProvidersRevision] = useState(0);
	const generation = useRef(0);
	const revision = useRef(0);
	const locked = useRef(false);
	const current = useRef<DesktopAuthState | null>(null);
	const resumed = useRef(false);
	const providerReads = useRef(0);
	/** What the provider list was last read for: model counts and settled-flow revision. */
	const readFor = useRef("");
	const readKey = useRef("");

	const own = useCallback((flowId: string) => setOwned(previous => new Set(previous).add(flowId)), []);
	const apply = useCallback((state: DesktopAuthState | null) => {
		const previous = current.current;
		current.current = state;
		setAuth(state);
		// A flow seen settling may have changed which credentials exist; the first read is not one.
		if (previous && state && !isActiveFlow(state) && (previous.id !== state.id || isActiveFlow(previous)))
			setProvidersRevision(value => value + 1);
	}, []);

	useEffect(() => {
		const scope = ++generation.current;
		let unsubscribe: (() => void) | undefined;
		let failed = false;
		setReady(false);
		setBusy(false);
		setOpening(false);
		setError("");
		locked.current = false;
		const alive = () => generation.current === scope;
		if (connected) {
			void (async () => {
				try {
					const stop = await subscribe(frame => {
						if (!alive()) return;
						if (frame.type === "auth") {
							revision.current += 1;
							apply(frame.auth);
						} else if (frame.type === "fatal") {
							failed = true;
							revision.current += 1;
							setReady(false);
						}
					});
					if (!alive()) {
						stop();
						return;
					}
					unsubscribe = stop;
					const version = revision.current;
					const read = ++providerReads.current;
					readFor.current = readKey.current;
					// `auth.state` is read only here: on a settled flow with stored credentials the Host
					// refreshes catalogs and publishes a snapshot, so re-reading it on model changes loops.
					const [state, list] = await Promise.all([
						request<DesktopAuthState | null>("auth.state"),
						request<DesktopAuthProvider[]>("auth.providers"),
					]);
					if (!alive() || failed) return;
					if (revision.current === version) apply(state);
					if (read === providerReads.current) setProviders(list);
					setLoaded(true);
					setLoadError("");
					const flow = current.current;
					if (!resumed.current) {
						resumed.current = true;
						if (flow && isActiveFlow(flow)) {
							own(flow.id);
							setSelected(flow.provider);
						}
					}
					setReady(true);
				} catch {
					if (alive() && !failed) setLoadError(t("providers.loadFailed"));
				}
			})();
		}
		return () => {
			generation.current += 1;
			unsubscribe?.();
		};
	}, [connected, reload, apply, own]);

	// Presence and counts follow models and settled flows; only the provider list is re-read.
	const key = `${[...modelCounts(models)]
		.map(([provider, count]) => `${provider}:${count}`)
		.sort()
		.join(",")}|${providersRevision}`;
	readKey.current = key;
	useEffect(() => {
		if (!connected || !loaded || readFor.current === key) return;
		readFor.current = key;
		const scope = generation.current;
		const read = ++providerReads.current;
		void request<DesktopAuthProvider[]>("auth.providers").then(
			list => {
				if (generation.current === scope && read === providerReads.current) setProviders(list);
			},
			() => {
				/* The last list stays; the next settled flow or model change reads again. */
			},
		);
	}, [connected, loaded, key]);

	async function act(method: "auth.login" | "auth.answer" | "auth.cancel", params: Record<string, unknown>) {
		if (!ready || !connected || locked.current) return;
		locked.current = true;
		setBusy(true);
		setError("");
		const scope = generation.current;
		const version = revision.current;
		try {
			const state = await request<DesktopAuthState>(method, params);
			if (generation.current !== scope) return;
			if (method === "auth.login") own(state.id);
			if (revision.current === version) apply(state);
		} catch (failure) {
			if (generation.current === scope) setError(failureMessage(failure, t("providers.requestFailed")));
		} finally {
			if (generation.current === scope) {
				locked.current = false;
				setBusy(false);
			}
		}
	}

	async function saveKey(provider: string, draft: string) {
		const result = normalizeApiKeyDraft(draft);
		if (!result.ok) {
			setKeyState({ provider, status: "invalid", reason: result.reason });
			return;
		}
		if (!ready || !connected || locked.current) return;
		locked.current = true;
		setBusy(true);
		setError("");
		setKeyState({ provider, status: "saving" });
		const scope = generation.current;
		try {
			const saved = await request<DesktopCredentialSaveResult>("auth.setKey", { provider, key: result.key });
			if (generation.current === scope)
				setKeyState({ provider, status: "saved", catalogRefreshed: saved.catalogRefreshed });
		} catch (failure) {
			if (generation.current === scope)
				setKeyState({ provider, status: "error", error: failureMessage(failure, t("providers.keySaveFailed")) });
		} finally {
			if (generation.current === scope) {
				locked.current = false;
				setBusy(false);
				setProvidersRevision(value => value + 1);
			}
		}
	}

	function openUrl(url: string) {
		const scope = generation.current;
		setOpening(true);
		setError("");
		void openExternalUrl(url)
			.catch(failure => {
				if (generation.current === scope) setError(failureMessage(failure, t("providers.flowOpenFailed")));
			})
			.finally(() => {
				if (generation.current === scope) setOpening(false);
			});
	}

	/** Leaving a provider dismisses the finished result it was showing, so its methods return. */
	function select(next: string | null) {
		const flow = current.current;
		if (flow && !isActiveFlow(flow) && flow.provider === selected && next !== selected)
			setOwned(previous => {
				const remaining = new Set(previous);
				remaining.delete(flow.id);
				return remaining;
			});
		setKeyState(null);
		setError("");
		setSelected(next);
	}

	return {
		groups: projectProviders(providers, models, auth, owned),
		flow: visibleFlow(auth, owned),
		loaded,
		loadError: loaded ? undefined : loadError || undefined,
		busy: busy || (loaded && !ready && connected),
		opening,
		error,
		keyState,
		selected,
		select,
		retry: () => setReload(value => value + 1),
		signIn: (provider: string) => {
			setKeyState(null);
			void act("auth.login", { provider });
		},
		answer: (flowId: string, promptId: string, value: string) => void act("auth.answer", { flowId, promptId, value }),
		cancel: (flowId: string) => void act("auth.cancel", { flowId }),
		saveKey: (provider: string, draft: string) => void saveKey(provider, draft),
		openUrl,
	};
}

/** Provider registration: one modal that owns the app's authorization requests while it is open. */
export function ProvidersDialog({ connected, models, onClose }: ProvidersDialogProps) {
	const authorization = useProviderAuthorization(connected, models);
	const [query, setQuery] = useState("");
	const search = useRef<HTMLInputElement>(null);
	// Runs after the modal's own effect has shown it, so the search field keeps the focus.
	useEffect(() => {
		search.current?.focus();
	}, []);
	return (
		<Modal title={t("providers.dialogTitle")} className="providers-dialog" onClose={onClose}>
			<ProvidersPanel
				groups={authorization.groups}
				totalModels={models.length}
				loaded={authorization.loaded}
				loadError={authorization.loadError}
				disconnected={!connected}
				busy={authorization.busy}
				query={query}
				onQueryChange={setQuery}
				selected={authorization.selected}
				onSelect={authorization.select}
				flow={authorization.flow}
				keyState={authorization.keyState}
				error={authorization.error}
				opening={authorization.opening}
				searchRef={search}
				onRetryLoad={authorization.retry}
				onSignIn={authorization.signIn}
				onAnswer={authorization.answer}
				onCancel={authorization.cancel}
				onSaveKey={authorization.saveKey}
				onOpenUrl={authorization.openUrl}
				onDone={onClose}
			/>
		</Modal>
	);
}
