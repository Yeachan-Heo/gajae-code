import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopAuthProvider, DesktopAuthState } from "../../desktop-host/src/protocol";
import { openAuthUrl, request, subscribe } from "./bridge";
import { Button, ErrorBanner } from "./components";

const statuses = {
	authorizing: "인증 진행 중",
	waiting: "인증 응답 대기 중",
	complete: "계정 연결 완료",
	cancelled: "계정 연결 취소됨",
	error: "계정 연결 실패",
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
							setError("인증 호스트와의 연결이 끊겼습니다.");
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
					if (alive()) setError("계정 연결 정보를 불러오지 못했습니다. 다시 시도하세요.");
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
			if (generation.current === scope && revision.current === version)
				setError("인증 요청을 처리하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.");
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
			<h3 id="oauth-title">계정 연결</h3>
			<p className="muted">
				설정을 닫아도 진행 중인 외부 로그인은 취소되지 않습니다. 다시 열면 이어서 진행할 수 있습니다. 입력한 응답은
				닫을 때 지워집니다.
			</p>
			{error && <ErrorBanner>{error}</ErrorBanner>}
			{!ready && !error && (
				<p role="status">{connected ? "계정 연결 정보를 불러오는 중…" : "호스트 연결이 필요합니다."}</p>
			)}
			{!ready && error && (
				<Button disabled={!connected} onClick={() => setReload(previous => previous + 1)}>
					다시 불러오기
				</Button>
			)}
			<label htmlFor="oauth-provider">계정 제공자</label>
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
					계정 연결
				</Button>
			</div>
			{ready && providers.length === 0 && <p>연결 가능한 계정 제공자가 없습니다.</p>}
			{auth && (
				<div className="oauth-flow">
					<p role="status">
						<strong>{providers.find(provider => provider.id === auth.provider)?.name ?? auth.provider}</strong> ·{" "}
						{statuses[auth.status]}
					</p>
					{auth.status === "error" && (
						<ErrorBanner>{auth.error || "계정 연결을 완료하지 못했습니다."}</ErrorBanner>
					)}
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
															cause instanceof Error ? cause.message : "인증 페이지를 열지 못했습니다.",
														);
												})
												.finally(() => {
													if (generation.current === scope) setOpening(false);
												});
										}}
									>
										브라우저에서 인증 페이지 열기
									</Button>
								</>
							)}
							{auth.url && !url && <ErrorBanner>안전한 HTTPS 인증 주소가 아니므로 열 수 없습니다.</ErrorBanner>}
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
										응답 제출
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
									계정 연결 취소
								</Button>
							</div>
						</>
					)}
				</div>
			)}
		</section>
	);
}
