import { ArrowDownToLine, Check, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ErrorBanner } from "./components";
import { t } from "./i18n";
import { type DesktopUpdateCheck, desktopUpdateClient } from "./update-client";

export interface DesktopUpdatesState {
	native: boolean;
	result: DesktopUpdateCheck | null;
	status: "idle" | "checking" | "installing" | "installed" | "error";
	error: string | null;
	notificationVisible: boolean;
	check(): Promise<void>;
	install(): Promise<void>;
	dismiss(): void;
}

/** One instance belongs to the app shell; the settings panel and banner share it. */
export function useDesktopUpdates(client = desktopUpdateClient): DesktopUpdatesState {
	const [native] = useState(() => client.isNative());
	const [result, setResult] = useState<DesktopUpdateCheck | null>(null);
	const [status, setStatus] = useState<DesktopUpdatesState["status"]>("idle");
	const [error, setError] = useState<string | null>(null);
	const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
	const mounted = useRef(false);
	const operation = useRef<Promise<void> | null>(null);
	const installed = useRef(false);
	const latest = useRef<DesktopUpdateCheck | null>(null);

	const check = useCallback((): Promise<void> => {
		if (operation.current) return operation.current;
		if (!native || !mounted.current || installed.current) return Promise.resolve();
		setStatus("checking");
		setError(null);
		const pending = Promise.resolve()
			.then(() => client.check())
			.then(value => {
				if (!mounted.current) return;
				// An available response without a target version cannot authorize installation.
				if (value.available && (!value.version || value.reason)) throw new Error(t("settings.updatesUnavailable"));
				latest.current = value;
				setResult(value);
				setStatus("idle");
			})
			.catch(cause => {
				if (!mounted.current) return;
				latest.current = null;
				setResult(previous => (previous ? { ...previous, available: false, version: undefined } : null));
				setError(`${t("settings.updatesCheckFailed")}: ${String(cause instanceof Error ? cause.message : cause)}`);
				setStatus("error");
			})
			.finally(() => {
				operation.current = null;
			});
		operation.current = pending;
		return pending;
	}, [client, native]);

	const install = useCallback((): Promise<void> => {
		if (operation.current) return operation.current;
		if (!native || !mounted.current || installed.current || !latest.current?.available) return Promise.resolve();
		setStatus("installing");
		setError(null);
		const pending = Promise.resolve()
			.then(() => client.install())
			.then(() => {
				installed.current = true;
				if (mounted.current) setStatus("installed");
			})
			.catch(cause => {
				if (!mounted.current) return;
				latest.current = null;
				setResult(previous => (previous ? { ...previous, available: false } : null));
				setError(
					`${t("settings.updatesInstallFailed")}: ${String(cause instanceof Error ? cause.message : cause)}`,
				);
				setStatus("error");
			})
			.finally(() => {
				operation.current = null;
			});
		operation.current = pending;
		return pending;
	}, [client, native]);

	useEffect(() => {
		mounted.current = true;
		if (!native)
			return () => {
				mounted.current = false;
			};
		void check();
		const timer = setInterval(
			() => {
				void check();
			},
			6 * 60 * 60 * 1000,
		);
		return () => {
			mounted.current = false;
			clearInterval(timer);
		};
	}, [check, native]);

	const dismiss = useCallback(() => {
		const version = result?.version;
		if (version) setDismissed(previous => new Set([...previous, version]));
	}, [result?.version]);
	return {
		native,
		result,
		status,
		error,
		check,
		install,
		dismiss,
		notificationVisible: Boolean(
			result?.version && (result.available || status === "error") && !dismissed.has(result.version),
		),
	};
}

export interface UpdatesPanelProps {
	updates: DesktopUpdatesState;
}

function UpdateStatus({ updates }: UpdatesPanelProps) {
	if (updates.status === "installed")
		return (
			<p role="status">
				<Check size={16} aria-hidden="true" />
				{t("settings.updatesRestart")}
			</p>
		);
	if (updates.status === "installing" || updates.status === "checking")
		return (
			<p role="status">
				<LoaderCircle size={16} aria-hidden="true" />
				{t(updates.status === "installing" ? "settings.updatesInstalling" : "settings.updatesChecking")}
			</p>
		);
	if (!updates.native) return <p>{t("settings.updatesBrowser")}</p>;
	if (updates.error) return <ErrorBanner>{updates.error}</ErrorBanner>;
	if (updates.result?.reason)
		return (
			<p>
				{t("settings.updatesUnavailable")}: {updates.result.reason}
			</p>
		);
	return (
		<p role="status">
			{updates.result?.available
				? t("settings.updatesAvailable", { version: updates.result.version ?? t("settings.updatesUnknown") })
				: t(updates.result ? "settings.updatesCurrent" : "settings.updatesIdle")}
		</p>
	);
}

function InstallButton({ updates }: UpdatesPanelProps) {
	if (!updates.result?.available || updates.result.reason || !updates.result.version || updates.status === "installed")
		return null;
	return (
		<Button
			onClick={() => {
				void updates.install();
			}}
			disabled={!updates.native || updates.status === "checking" || updates.status === "installing"}
		>
			<ArrowDownToLine aria-hidden="true" />
			{t("settings.updatesInstall")}
		</Button>
	);
}

export function UpdatesPanel({ updates }: UpdatesPanelProps) {
	return (
		<section
			className="updates-panel"
			aria-label={t("settings.updatesTitle")}
			aria-busy={updates.status === "checking" || updates.status === "installing"}
		>
			<dl className="updates-versions">
				<div>
					<dt>{t("settings.updatesApp")}</dt>
					<dd>{updates.result?.currentVersion ?? t("settings.updatesUnknown")}</dd>
				</div>
				<div>
					<dt>{t("settings.updatesEngine")}</dt>
					<dd>{updates.result?.bundledGjcVersion ?? t("settings.updatesUnknown")}</dd>
				</div>
			</dl>
			<p className="updates-note">{t("settings.updatesTogether")}</p>
			<UpdateStatus updates={updates} />
			<div className="actions updates-actions">
				<Button
					onClick={() => {
						void updates.check();
					}}
					disabled={
						!updates.native ||
						updates.status === "checking" ||
						updates.status === "installing" ||
						updates.status === "installed"
					}
				>
					<RefreshCw aria-hidden="true" />
					{t("settings.updatesCheck")}
				</Button>
				<InstallButton updates={updates} />
			</div>
		</section>
	);
}

export function UpdatesNotification({ updates }: UpdatesPanelProps) {
	if (!updates.notificationVisible) return null;
	return (
		<aside className="updates-notification" aria-label={t("settings.updatesTitle")} aria-live="polite">
			<UpdateStatus updates={updates} />
			<div className="actions updates-actions">
				<InstallButton updates={updates} />
				{updates.status === "error" && (
					<Button
						onClick={() => {
							void updates.check();
						}}
					>
						<RefreshCw aria-hidden="true" />
						{t("settings.updatesCheck")}
					</Button>
				)}
				<Button onClick={updates.dismiss}>
					<X aria-hidden="true" />
					{t("settings.updatesDismiss")}
				</Button>
			</div>
		</aside>
	);
}
