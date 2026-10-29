import { Brain } from "lucide-react";
import { useId } from "react";
import type { DesktopThinking, DesktopThinkingLevel } from "../../desktop-host/src/protocol";

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
	const id = useId();
	const options = thinking?.options ?? [];
	const value = thinking?.level ?? "";
	const currentListed = options.some(option => option.value === value);
	const unavailable = !thinking?.available || options.length === 0;
	return (
		<label className="reasoning-control" htmlFor={id} title={thinking?.reason ?? "다음 요청에 사용할 추론 수준"}>
			<Brain size={15} aria-hidden="true" />
			<span className="sr-only">추론 수준</span>
			<select
				id={id}
				value={value}
				disabled={disabled || pending || unavailable}
				aria-label="추론 수준"
				onChange={event => {
					const option = options.find(item => item.value === event.target.value);
					if (option) onChange(option.value);
				}}
			>
				{!currentListed && (
					<option value={value} disabled>
						{pending ? "추론 설정 적용 중…" : unavailable ? (thinking?.mode === "always-on" ? "추론 항상 켜짐" : "추론 설정 없음") : value || "모델 기본값"}
					</option>
				)}
				{options.map(option => (
					<option key={option.value} value={option.value} title={option.description}>
						{option.label}
					</option>
				))}
			</select>
		</label>
	);
}
