import { Brain } from "lucide-react";
import type { DesktopThinking, DesktopThinkingLevel } from "../../desktop-host/src/protocol";
import { t } from "./i18n";
import { Select } from "./Select";

export function ReasoningSelect({
	thinking,
	disabled,
	pending,
	onChange,
}: {
	thinking?: DesktopThinking;
	disabled?: boolean;
	pending?: boolean;
	onChange: (level: DesktopThinkingLevel) => void;
}) {
	const options = thinking?.options ?? [];
	const value = thinking?.level ?? "";
	const current = options.find(option => option.value === value);
	const unavailable = !thinking?.available || options.length === 0;
	const fallbackLabel = pending
		? t("models.reasoningApplying")
		: unavailable
			? thinking?.mode === "always-on"
				? t("models.reasoningAlwaysOn")
				: t("models.reasoningNone")
			: value || t("models.modelDefault");
	return (
		<div className="reasoning-control">
			<Select
				value={value}
				options={options}
				placeholder={fallbackLabel}
				ariaLabel={t("models.reasoningLevelFor", { level: current?.label ?? fallbackLabel })}
				title={thinking?.reason ?? t("models.reasoningLevelTitle")}
				icon={<Brain size={15} aria-hidden="true" />}
				disabled={!!disabled || !!pending || unavailable}
				onChange={level => onChange(level as DesktopThinkingLevel)}
			/>
		</div>
	);
}
