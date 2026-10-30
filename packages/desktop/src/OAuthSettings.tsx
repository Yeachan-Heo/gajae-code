import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopAuthProvider, DesktopAuthState } from "../../desktop-host/src/protocol";
import { openAuthUrl, request, subscribe } from "./bridge";
import { Button, ErrorBanner } from "./components";
import { t } from "./i18n";

const statuses = {
	authorizing: () => t("settings.oauthStatusAuthorizing"),
	waiting: () => t("settings.oauthStatusWaiting"),
	complete: () => t("settings.oauthStatusComplete"),
	cancelled: () => t("settings.oauthStatusCancelled"),
	error: () => t("settings.oauthStatusError"),
};

function authorizationUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
	} catch {
		return undefined;
	}
}

export function OAuthSettings({ connected }: { connected: boolean }) {
	const [providers, setProviders] = useState<DesktopAuthProvider[]>([]);
	const [provider, setProvider] = useState("");
	const [auth, setAuth] = useState<DesktopAuthState | null>(null);
	const [ready, setReady] = useState(false);
	const [busy, setBusy] = useState(false);
	const [opening, setOpening] = useState(false);
	const [value, setValue] = useState("");
	const [error, setError] = useState("");
	const [reload, setReload] = useState(0);
	const generation = useRef(0);
	const revision = useRef(0);
	const locked = useRef(false);
	const current = useRef<DesktopAuthState | null>(null);

	const apply = useCallback((state: DesktopAuthState | null) => {
		if (
			current.current?.id !== state?.id ||
			current.current?.prompt?.id !== state?.prompt?.id ||
			state?.status !== "waiting"
		)
			setValue("");
		current.current = state;
		setAuth(state);
	}, []);

	useEffect(() => {
		const scope = ++generation.current;
		let unsubscribe: (() => void) | undefined;
		let failed = false;
		setReady(false);
		setBusy(false);
		setOpening(false);
		setValue("");
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
							setValue("");
							setError(t("settings.oauthHostLost"));
						}
					});
					if (!alive()) {
						stop();
						return;
					}
					unsubscribe = stop;
					const version = revision.current;
					const [state, available] = await Promise.all([
						request<DesktopAuthState | null>("auth.state"),
						request<DesktopAuthProvider[]>("auth.providers"),
					]);
					if (!alive() || failed) return;
					if (revision.current === version) apply(state);
					setProviders(available);
					setProvider(previous =>
						available.some(item => item.id === previous) ? previous : (available[0]?.id ?? ""),
					);
					setReady(true);
				} catch {
					if (alive()) setError(t("settings.oauthLoadFailed"));
				}
			})();
		}
		return () => {
			generation.current += 1;
			unsubscribe?.();
		};
	}, [connected, reload, apply]);

	async function act(method: "auth.login" | "auth.answer" | "auth.cancel", params: Record<string, unknown>) {
		if (!ready || !connected || locked.current) return;
		locked.current = true;
		setBusy(true);
		setError("");
		const scope = generation.current;
		const version = revision.current;
		try {
			const state = await request<DesktopAuthState>(method, params);
			if (generation.current === scope && revision.current === version) apply(state);
		} catch {
			if (generation.current === scope && revision.current === version) setError(t("settings.oauthRequestFailed"));
		} finally {
			if (generation.current === scope) {
				locked.current = false;
				setBusy(false);
			}
		}
	}

	const active = auth?.status === "authorizing" || auth?.status === "waiting";
	const url = authorizationUrl(auth?.url);
	const prompt = active ? auth?.prompt : undefined;
	return (
		<section className="oauth-settings" aria-labelledby="oauth-title">
			<h3 id="oauth-title">{t("settings.oauthHeading")}</h3>
			{error && <ErrorBanner>{error}</ErrorBanner>}
			{!ready && !error && (
				<p role="status">{connected ? t("settings.oauthLoading") : t("settings.oauthNeedsHost")}</p>
			)}
			{!ready && error && (
				<Button disabled={!connected} onClick={() => setReload(previous => previous + 1)}>
					{t("settings.oauthReload")}
				</Button>
			)}
			<label htmlFor="oauth-provider">{t("settings.oauthProviderLabel")}</label>
			<select
				id="oauth-provider"
				value={provider}
				disabled={!connected || !ready || busy || active || providers.length === 0}
				onChange={event => setProvider(event.target.value)}
			>
				{providers.map(item => (
					<option key={item.id} value={item.id}>
						{item.name}
					</option>
				))}
			</select>
			<div className="actions">
				<Button
					disabled={!connected || !ready || busy || active || !provider}
					onClick={() => void act("auth.login", { provider })}
				>
					{t("settings.oauthConnect")}
				</Button>
			</div>
			{ready && providers.length === 0 && <p>{t("settings.oauthNoProviders")}</p>}
			{auth && (
				<div className="oauth-flow">
					<p role="status">
						<strong>{providers.find(provider => provider.id === auth.provider)?.name ?? auth.provider}</strong> ·{" "}
						{statuses[auth.status]()}
					</p>
					{auth.status === "error" && <ErrorBanner>{auth.error || t("settings.oauthIncomplete")}</ErrorBanner>}
					{auth.instructions && <pre className="bounded-output">{auth.instructions}</pre>}
					{active && (
						<>
							{url && (
								<>
									<p className="oauth-url">{url}</p>
									<Button
										disabled={!connected || !ready || opening}
										onClick={() => {
											const scope = generation.current;
											const version = revision.current;
											setOpening(true);
											setError("");
											void openAuthUrl(url)
												.catch(cause => {
													if (generation.current === scope && revision.current === version)
														setError(
															cause instanceof Error ? cause.message : t("settings.oauthOpenFailed"),
														);
												})
												.finally(() => {
													if (generation.current === scope) setOpening(false);
												});
										}}
									>
										{t("settings.oauthOpen")}
									</Button>
								</>
							)}
							{auth.url && !url && <ErrorBanner>{t("settings.oauthInsecureUrl")}</ErrorBanner>}
							{prompt && (
								<form
									onSubmit={event => {
										event.preventDefault();
										const answer = value;
										setValue("");
										void act("auth.answer", { flowId: auth.id, promptId: prompt.id, value: answer });
									}}
								>
									<label htmlFor="oauth-answer">{prompt.message}</label>
									<input
										id="oauth-answer"
										type="password"
										autoComplete="off"
										spellCheck={false}
										placeholder={prompt.placeholder}
										value={value}
										disabled={!connected || !ready || busy}
										onChange={event => setValue(event.target.value)}
										required={!prompt.allowEmpty}
									/>
									<Button
										type="submit"
										disabled={!connected || !ready || busy || (!prompt.allowEmpty && !value)}
									>
										{t("settings.oauthSubmit")}
									</Button>
								</form>
							)}
							<div className="actions">
								<Button
									disabled={!connected || !ready || busy}
									onClick={() => {
										setValue("");
										void act("auth.cancel", { flowId: auth.id });
									}}
								>
									{t("settings.oauthCancel")}
								</Button>
							</div>
						</>
					)}
				</div>
			)}
		</section>
	);
}
