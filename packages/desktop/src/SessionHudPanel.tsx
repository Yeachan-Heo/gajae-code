import type { DesktopSessionInfo, DesktopSessionPullRequest } from "@gajae-code/desktop-host/session-info-protocol";
import {
	Brain,
	Coins,
	Cpu,
	Folder,
	Gauge,
	GitBranch,
	GitPullRequest,
	Layers,
	type LucideIcon,
	MessageSquareText,
	Package,
	RefreshCw,
	Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button, ErrorBanner } from "./components";
import { t } from "./i18n";
import { SessionInfoPanel } from "./SessionInfoPanel";

export interface SessionHudPanelProps {
	info: DesktopSessionInfo | null;
	/** `undefined` while the lookup has not answered; `null` when the branch has no open pull request. */
	pullRequest: DesktopSessionPullRequest | null | undefined;
	pending?: boolean;
	error?: string;
	onRefresh(): void;
	onOpenPullRequest(url: string): void;
}

const TEXT_LIMIT = 240;

/** Host-redacted text stays inert and bounded, without splitting a surrogate pair. */
function bounded(text: string): string {
	if (text.length <= TEXT_LIMIT) return text;
	let end = TEXT_LIMIT - 1;
	if (/[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
	return `${text.slice(0, end)}…`;
}

function finite(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Same scale as the TUI status line: 999, 1.2K, 45K, 1.2M. */
function compact(value: number): string {
	if (value < 1000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1000).toFixed(1)}K`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}K`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

function Unknown() {
	return (
		<span className="session-hud-unknown" title={t("panels.unknown")}>
			<span aria-hidden="true">—</span>
			<span className="sr-only">{t("panels.unknown")}</span>
		</span>
	);
}

function Tile({
	icon: Icon,
	label,
	title,
	wide = false,
	children,
}: {
	icon: LucideIcon;
	label: string;
	title?: string;
	wide?: boolean;
	children: ReactNode;
}) {
	return (
		<div className="session-hud-tile" data-wide={wide || undefined} title={title}>
			<dt>
				<Icon size={14} aria-hidden="true" />
				{label}
			</dt>
			<dd>{children}</dd>
		</div>
	);
}

function Text({ value }: { value: string | null }) {
	return value === null || value === "" ? <Unknown /> : bounded(value);
}

export function SessionHudPanel({
	info,
	pullRequest,
	pending = false,
	error,
	onRefresh,
	onOpenPullRequest,
}: SessionHudPanelProps) {
	return (
		<section className="session-hud-panel" aria-label={t("panels.hud")} aria-busy={pending}>
			<header className="session-hud-heading">
				<Button
					className="session-hud-refresh"
					aria-label={t("panels.hudRefresh")}
					title={t("panels.hudRefresh")}
					onClick={onRefresh}
				>
					<RefreshCw size={15} aria-hidden="true" />
				</Button>
			</header>
			{error && (
				<ErrorBanner>
					<span className="session-info-text">{bounded(error)}</span>
				</ErrorBanner>
			)}
			{info === null ? (
				<p className="session-info-note" role="status">
					{t("panels.hudLoading")}
				</p>
			) : !info.available ? (
				<ErrorBanner>
					<span className="session-info-text">{bounded(info.reason)}</span>
				</ErrorBanner>
			) : (
				<>
					<SessionHudGrid info={info} pullRequest={pullRequest} onOpenPullRequest={onOpenPullRequest} />
					<details className="session-hud-details">
						<summary>{t("panels.hudDetails")}</summary>
						<SessionInfoPanel info={info} />
					</details>
				</>
			)}
		</section>
	);
}

function SessionHudGrid({
	info,
	pullRequest,
	onOpenPullRequest,
}: {
	info: Extract<DesktopSessionInfo, { available: true }>;
	pullRequest: DesktopSessionPullRequest | null | undefined;
	onOpenPullRequest(url: string): void;
}) {
	const { context, hud, recordedTotals } = info;
	const percent = context.source !== "unknown" && finite(context.percent) ? context.percent : null;
	const contextWindow = finite(context.contextWindow) ? context.contextWindow : null;
	const tokens = finite(context.tokens) ? context.tokens : null;
	const cost = recordedTotals.available && finite(recordedTotals.cost.amount) ? recordedTotals.cost.amount : null;
	const jobs = hud.jobs !== null && Number.isSafeInteger(hud.jobs) && hud.jobs >= 0 ? hud.jobs : null;
	const speed = finite(hud.tokensPerSecond) ? hud.tokensPerSecond : null;
	return (
		<dl className="session-hud">
			<Tile
				icon={Cpu}
				label={t("panels.hudModel")}
				title={info.model ? bounded(`${info.model.provider}/${info.model.id}`) : undefined}
			>
				<Text value={info.model?.name ?? null} />
			</Tile>
			<Tile icon={Brain} label={t("panels.hudReasoning")}>
				<Text value={info.thinkingLevel} />
			</Tile>
			<Tile
				icon={Gauge}
				label={t("panels.hudContext")}
				title={
					tokens !== null && contextWindow !== null ? `${compact(tokens)} / ${compact(contextWindow)}` : undefined
				}
			>
				{percent === null ? (
					<Unknown />
				) : (
					<>
						{`${percent.toFixed(1)}%`}
						{contextWindow !== null && <small>{` / ${compact(contextWindow)}`}</small>}
						<meter
							className="session-hud-meter"
							aria-label={t("panels.hudContext")}
							aria-valuetext={`${percent.toFixed(1)}%`}
							min={0}
							max={100}
							low={70}
							high={90}
							optimum={0}
							value={Math.min(100, percent)}
						/>
					</>
				)}
			</Tile>
			<Tile icon={Coins} label={t("panels.hudCost")} title={t("panels.hudCostNote")}>
				{cost === null ? <Unknown /> : `$${cost.toFixed(2)}`}
			</Tile>
			<Tile icon={GitBranch} label={t("panels.hudBranch")}>
				<Text value={hud.branch} />
			</Tile>
			<Tile icon={GitPullRequest} label={t("panels.hudPullRequest")}>
				{pullRequest === undefined ? (
					<span className="session-hud-unknown" title={t("panels.hudLoading")}>
						<span aria-hidden="true">…</span>
						<span className="sr-only">{t("panels.hudLoading")}</span>
					</span>
				) : pullRequest === null ? (
					<Unknown />
				) : (
					<button
						type="button"
						className="session-hud-link"
						title={bounded(pullRequest.url)}
						onClick={() => onOpenPullRequest(pullRequest.url)}
					>
						{`#${pullRequest.number}`}
					</button>
				)}
			</Tile>
			<Tile icon={Layers} label={t("panels.hudJobs")}>
				{jobs === null ? <Unknown /> : String(jobs)}
			</Tile>
			<Tile icon={Zap} label={t("panels.hudSpeed")}>
				{speed === null ? <Unknown /> : `${speed.toFixed(1)}/s`}
			</Tile>
			<Tile icon={MessageSquareText} label={t("panels.hudTitle")} wide>
				<Text value={info.metadata.name} />
			</Tile>
			<Tile icon={Folder} label={t("panels.hudDirectory")} wide>
				<span className="session-hud-path">{bounded(info.metadata.cwd)}</span>
			</Tile>
			<Tile icon={Package} label={t("panels.hudVersion")}>
				{`v${bounded(hud.version)}`}
			</Tile>
		</dl>
	);
}
