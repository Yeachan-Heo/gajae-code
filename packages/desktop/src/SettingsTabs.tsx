import { useRef } from "react";
import { Button } from "./components";
import { t } from "./i18n";

/** Sections of the settings dialog. One panel is visible at a time; the tab order is stable. */
export const SETTINGS_TABS = ["general", "account", "settings", "capabilities"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const labels: Record<SettingsTab, () => string> = {
	general: () => t("shell.settingsTabGeneral"),
	account: () => t("shell.settingsTabAccount"),
	settings: () => t("shell.settingsTabSettings"),
	capabilities: () => t("shell.settingsTabCapabilities"),
};

/** Stable ids so a panel and its tab can point at each other. */
export const settingsTabId = (prefix: string, tab: SettingsTab) => `${prefix}-tab-${tab}`;
export const settingsPanelId = (prefix: string, tab: SettingsTab) => `${prefix}-panel-${tab}`;

export function SettingsTabs({
	prefix,
	active,
	onSelect,
}: {
	prefix: string;
	active: SettingsTab;
	onSelect: (tab: SettingsTab) => void;
}) {
	const list = useRef<HTMLDivElement>(null);
	// Roving tabindex: arrows move focus and selection together, like the theme radios.
	const move = (direction: 1 | -1 | "first" | "last") => {
		const index = SETTINGS_TABS.indexOf(active);
		const next =
			direction === "first"
				? 0
				: direction === "last"
					? SETTINGS_TABS.length - 1
					: (index + direction + SETTINGS_TABS.length) % SETTINGS_TABS.length;
		const target = SETTINGS_TABS[next];
		if (!target) return;
		onSelect(target);
		list.current?.querySelector<HTMLButtonElement>(`[id="${settingsTabId(prefix, target)}"]`)?.focus();
	};
	return (
		<div
			ref={list}
			className="settings-tabs"
			role="tablist"
			aria-label={t("shell.settingsTabsLabel")}
			onKeyDown={event => {
				if (event.key === "ArrowRight" || event.key === "ArrowDown") {
					event.preventDefault();
					move(1);
				} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
					event.preventDefault();
					move(-1);
				} else if (event.key === "Home") {
					event.preventDefault();
					move("first");
				} else if (event.key === "End") {
					event.preventDefault();
					move("last");
				}
			}}
		>
			{SETTINGS_TABS.map(tab => (
				<Button
					key={tab}
					id={settingsTabId(prefix, tab)}
					className="settings-tab"
					role="tab"
					aria-selected={active === tab}
					aria-controls={settingsPanelId(prefix, tab)}
					tabIndex={active === tab ? 0 : -1}
					onClick={() => onSelect(tab)}
				>
					{labels[tab]()}
				</Button>
			))}
		</div>
	);
}

/** One titled block inside a settings panel: heading, one-line explanation, content. */
export function SettingsSection({
	id,
	title,
	hint,
	children,
}: {
	id: string;
	title: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="settings-section" aria-labelledby={`${id}-heading`}>
			<div className="settings-section-head">
				<h3 id={`${id}-heading`}>{title}</h3>
				{hint && <p className="settings-hint">{hint}</p>}
			</div>
			<div className="settings-section-body">{children}</div>
		</section>
	);
}
