import { Check, RefreshCw } from "lucide-react";
import { useId } from "react";
import type {
	DesktopModelProfile,
	DesktopModelRolePreference,
	DesktopPreferenceAction,
	DesktopPreferenceResolution,
	DesktopPreferences,
	DesktopSamplingPreference,
} from "../../desktop-host/src/preferences-protocol";
import { Button, ErrorBanner } from "./components";
import { t } from "./i18n";

export interface PreferencesPanelProps {
	preferences: DesktopPreferences | null;
	pending?: boolean;
	error?: string;
	onRefresh: () => void;
	onApply: (action: DesktopPreferenceAction) => void;
}

const originLabels = {
	default: () => t("settings.originDefault"),
	global: () => t("settings.originGlobal"),
	project: () => t("settings.originProject"),
	runtime: () => t("settings.originRuntime"),
	layered: () => t("settings.originLayered"),
};

function Resolution({ resolution }: { resolution: DesktopPreferenceResolution }) {
	return (
		<>
			{originLabels[resolution.origin]()}
			{resolution.layers.length > 0 && (
				<>
					{" "}
					· {t("settings.layers")}: {resolution.layers.map(layer => originLabels[layer]()).join(" → ")}
				</>
			)}
		</>
	);
}

function ProfileOption({
	profile,
	pending,
	onApply,
}: {
	profile: DesktopModelProfile;
	pending?: boolean;
	onApply: (action: DesktopPreferenceAction) => void;
}) {
	const id = useId();
	const session = profile.capabilities.selectSession;
	const persisted = profile.capabilities.persistDefault;
	return (
		<li
			className="profile-option"
			data-active={profile.active || undefined}
			data-default={profile.default || undefined}
		>
			<div className="preference-badges">
				<span>
					{profile.source === "configured" ? t("settings.sourceConfigured") : t("settings.sourceBuiltin")}
				</span>
				{profile.active && (
					<span>
						<Check size={14} aria-hidden="true" />
						{t("settings.inUseSession")}
					</span>
				)}
				{profile.default && <span>{t("settings.savedDefault")}</span>}
			</div>
			<h4>{profile.name}</h4>
			<p className="preference-value">
				<code>{profile.id}</code>
			</p>
			{profile.description && <p className="muted">{profile.description}</p>}
			<div className="preference-actions actions">
				<Button
					aria-label={t("settings.applySessionAria", { name: profile.name, id: profile.id })}
					aria-pressed={profile.active}
					disabled={pending || !session.available || profile.active}
					onClick={() => {
						if (!pending && session.available && !profile.active) {
							onApply({ type: "profile.select", name: profile.id, scope: "session" });
						}
					}}
				>
					{profile.active ? t("settings.currentSessionProfile") : t("settings.applySession")}
				</Button>
				<Button
					aria-label={t("settings.saveDefaultAria", { name: profile.name, id: profile.id })}
					aria-pressed={profile.default}
					disabled={pending || !persisted.available || profile.default}
					onClick={() => {
						if (!pending && persisted.available && !profile.default) {
							onApply({ type: "profile.select", name: profile.id, scope: "default" });
						}
					}}
				>
					{profile.default ? t("settings.savedDefault") : t("settings.saveDefault")}
				</Button>
			</div>
			<p id={`${id}-session`} className="preference-reason">
				{t("settings.thisConversation")}{" "}
				{session.reason ??
					(session.available ? t("settings.thisConversationReason") : t("settings.sessionUnavailable"))}
			</p>
			<p id={`${id}-default`} className="preference-reason">
				{t("settings.savingDefault")}{" "}
				{persisted.reason ??
					(persisted.available ? t("settings.savingDefaultReason") : t("settings.defaultUnavailable"))}
			</p>
		</li>
	);
}

function RolePreference({ role }: { role: DesktopModelRolePreference }) {
	return (
		<li className="preference-row">
			<h4>{role.name}</h4>
			<dl>
				<div>
					<dt>{t("settings.configState")}</dt>
					<dd>{role.configured ? t("settings.explicitlyConfigured") : t("settings.inherited")}</dd>
				</div>
				<div>
					<dt>{t("settings.resolvedModel")}</dt>
					<dd className="preference-value">
						{role.model ? (
							<>
								{role.model.name}
								<br />
								<code>
									{role.model.provider} / {role.model.id}
								</code>
							</>
						) : (
							t("settings.noResolvedModel")
						)}
					</dd>
				</div>
				<div>
					<dt>{t("settings.reasoningLevel")}</dt>
					<dd>{role.thinkingLevel ?? t("settings.notSet")}</dd>
				</div>
				<div>
					<dt>{t("settings.roleMapOrigin")}</dt>
					<dd>
						<Resolution resolution={role.configurationResolution} />
					</dd>
				</div>
			</dl>
			<p className="preference-reason">
				{role.canApply.available
					? role.scope === "default"
						? t("settings.roleChangeDefault")
						: t("settings.roleChangeSession")
					: t("settings.cannotChange", { reason: role.canApply.reason ?? t("settings.roleLocked") })}
			</p>
		</li>
	);
}

function SamplingPreference({ sampling }: { sampling: DesktopSamplingPreference }) {
	const id = useId();
	return (
		<li className="preference-row">
			<h4>{sampling.parameter}</h4>
			<dl>
				<div>
					<dt>{t("settings.mergedValue")}</dt>
					<dd>
						{sampling.configuredValue ?? t("settings.noValue")}
						{sampling.mode === "provider-default" && ` · ${t("settings.providerDefault")}`}
						{sampling.mode === "invalid" && ` · ${t("settings.invalidSetting")}`}
					</dd>
				</div>
				<div>
					<dt>{t("settings.nextRunValue")}</dt>
					<dd>{sampling.effectiveValue ?? t("settings.noExplicitValue")}</dd>
				</div>
				<div>
					<dt>{t("settings.settingOrigin")}</dt>
					<dd>
						<Resolution resolution={sampling.resolution} />
					</dd>
				</div>
				<div>
					<dt>{t("settings.modelSupport")}</dt>
					<dd>{t("settings.modelSupportUnknown")}</dd>
				</div>
			</dl>
			<Button disabled aria-describedby={id}>
				{t("settings.samplingLocked")}
			</Button>
			<p id={id} className="preference-reason">
				{t("settings.readOnlyPrefix")} {sampling.canApply.reason ?? t("settings.samplingReason")}
			</p>
		</li>
	);
}

export function PreferencesPanel({ preferences, pending = false, error, onRefresh, onApply }: PreferencesPanelProps) {
	const id = useId();
	return (
		<section className="preferences-panel" aria-labelledby={`${id}-title`} aria-busy={pending}>
			<div className="preferences-toolbar">
				<div>
					<h2 id={`${id}-title`}>{t("settings.title")}</h2>
				</div>
				<Button disabled={pending} onClick={onRefresh}>
					<RefreshCw aria-hidden="true" />
					{t("settings.refresh")}
				</Button>
			</div>
			{error && <ErrorBanner>{error}</ErrorBanner>}
			{pending && (
				<p className="preference-reason" role="status">
					{preferences ? t("settings.pendingRetained") : t("settings.loading")}
				</p>
			)}
			{!preferences && !pending && !error && <p className="empty model-empty">{t("settings.empty")}</p>}
			{preferences && (
				<>
					<section className="preferences-group" aria-labelledby={`${id}-profiles`}>
						<h3 id={`${id}-profiles`}>{t("settings.profilesHeading")}</h3>
						{preferences.profiles.length === 0 ? (
							<p className="empty model-empty">{t("settings.profilesEmpty")}</p>
						) : (
							<ul className="preference-grid" aria-label={t("settings.profilesList")}>
								{preferences.profiles.map(profile => (
									<ProfileOption key={profile.id} profile={profile} pending={pending} onApply={onApply} />
								))}
							</ul>
						)}
					</section>
					<section className="preferences-group" aria-labelledby={`${id}-roles`}>
						<h3 id={`${id}-roles`}>{t("settings.rolesHeading")}</h3>
						{preferences.roles.length === 0 ? (
							<p className="empty model-empty">{t("settings.rolesEmpty")}</p>
						) : (
							<ul className="preference-grid" aria-label={t("settings.rolesList")}>
								{preferences.roles.map(role => (
									<RolePreference key={role.id} role={role} />
								))}
							</ul>
						)}
					</section>
					<section className="preferences-group" aria-labelledby={`${id}-sampling`}>
						<h3 id={`${id}-sampling`}>{t("settings.samplingHeading")}</h3>
						<p className="preference-reason">{t("settings.samplingHint")}</p>
						{preferences.sampling.length === 0 ? (
							<p className="empty model-empty">{t("settings.samplingEmpty")}</p>
						) : (
							<ul className="preference-grid" aria-label={t("settings.samplingList")}>
								{preferences.sampling.map(sampling => (
									<SamplingPreference key={sampling.parameter} sampling={sampling} />
								))}
							</ul>
						)}
					</section>
				</>
			)}
		</section>
	);
}
