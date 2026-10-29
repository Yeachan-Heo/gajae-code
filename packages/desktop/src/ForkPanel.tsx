import { useId } from "react";
import type { DesktopHistory } from "../../desktop-host/src/protocol";
import { Button } from "./components";

export interface ForkPanelProps {
	history: DesktopHistory | null;
	selectedEntryId: string;
	pending: boolean;
	disabled: boolean;
	onSelect: (entryId: string) => void;
	onFork: (entryId?: string) => void;
	onLoadMore: () => void;
}

export function ForkPanel({
	history,
	selectedEntryId,
	pending,
	disabled,
	onSelect,
	onFork,
	onLoadMore,
}: ForkPanelProps) {
	const id = useId();
	const entries = history?.messages.filter(message => message.role === "user" && message.entryId) ?? [];
	const selectedMessage = entries.find(message => message.entryId === selectedEntryId);
	const locked = pending || disabled;
	return (
		<div className="fork-panel">
			<p>
				사용자 메시지를 고르면 그 메시지 직전까지 새 대화에 복사합니다. 선택한 원문은 새 대화의 초안으로만 채우며
				전송하지 않습니다.
			</p>
			<Button
				disabled={locked}
				onClick={() => {
					if (!locked) onFork();
				}}
			>
				전체 대화 복사 (선택 없이 fork)
			</Button>
			<div>
				<label htmlFor={`${id}-entry`}>분기할 사용자 메시지</label>
				<select
					id={`${id}-entry`}
					value={selectedMessage ? selectedEntryId : ""}
					disabled={locked || entries.length === 0}
					onChange={event => {
						const entryId = event.target.value;
						if (!locked && (entryId === "" || entries.some(message => message.entryId === entryId))) {
							onSelect(entryId);
						}
					}}
				>
					<option value="">사용자 메시지를 선택하세요</option>
					{entries.map((message, index) => (
						<option key={message.entryId} value={message.entryId}>
							{index + 1}. {message.text.slice(0, 100) || "텍스트 없는 사용자 메시지"}
						</option>
					))}
				</select>
			</div>
			<div>
				<label htmlFor={`${id}-preview`}>선택한 메시지 미리보기 (읽기 전용)</label>
				<textarea
					id={`${id}-preview`}
					readOnly
					rows={6}
					value={selectedMessage?.text ?? ""}
					aria-describedby={selectedMessage?.truncated ? `${id}-truncation` : undefined}
				/>
				{selectedMessage?.truncated && (
					<p id={`${id}-truncation`} className="truncation-notice">
						미리보기 일부가 생략되어 표시된 내용은 전체 원문이 아닙니다. 분기 시 새 초안에는 SDK가 반환한 선택
						원문을 사용합니다.
					</p>
				)}
			</div>
			<Button
				disabled={locked || !selectedMessage}
				onClick={() => {
					if (!locked && selectedMessage?.entryId) onFork(selectedMessage.entryId);
				}}
			>
				선택한 메시지 직전에서 분기
			</Button>
			{history && entries.length === 0 && <p>불러온 기록에 분기 가능한 사용자 메시지가 없습니다.</p>}
			{history?.truncated && (
				<Button
					disabled={locked}
					onClick={() => {
						if (!locked) onLoadMore();
					}}
				>
					다음 500개 불러오기
				</Button>
			)}
		</div>
	);
}
