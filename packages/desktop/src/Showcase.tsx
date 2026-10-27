import { useState } from "react";
import type { DesktopSession } from "../../desktop-host/src/protocol";
import { Button, Composer, ErrorBanner, Message, Modal, QuestionCard, SessionRow, SettingField } from "./components";
import "./styles.css";

export default function Showcase() {
	const [draft, setDraft] = useState("");
	const [dialog, setDialog] = useState(false);
	const [answer, setAnswer] = useState("");
	const session: DesktopSession = {
		id: "showcase",
		projectId: "fixture",
		title: "한국어와 TypeScript 프로젝트 검토 — 긴 대화 이름",
		starred: false,
		status: "idle",
		messages: [],
	};
	return (
		<main className="showcase">
			<h1>GJC · 컴포넌트 상태</h1>
			<p>디자인 검토용 예시입니다. 실제 프로젝트나 연결 상태가 아닙니다.</p>
			<section>
				<h2>대화 · 선택과 백그라운드 상태</h2>
				{(["idle", "running", "waiting", "error"] as const).map((status, index) => (
					<SessionRow
						key={status}
						session={{ ...session, id: status, status, starred: index === 0 }}
						selected={index === 1}
						onSelect={() => setAnswer(status)}
						onStar={() => setAnswer("즐겨찾기 예시")}
					/>
				))}
			</section>
			<section>
				<h2>도구 모음</h2>
				<div className="actions">
					<Button onClick={() => setDialog(true)}>설정 열기</Button>
					<Button disabled>불러오는 중…</Button>
					<Button className="primary">새 대화</Button>
				</div>
				<p className="path">
					/Users/developer/Projects/아주-긴-한국어-프로젝트/packages/coding-agent/src/session/long-running-background-session.ts
				</p>
			</section>
			<section>
				<h2>메시지와 도구</h2>
				<Message
					message={{
						id: "1",
						role: "user",
						text: "변경 사항을 검토하고 안전하게 정리해 주세요. English와 한국어가 함께 있어도 읽기 편해야 합니다.",
					}}
				/>
				<Message
					message={{
						id: "2",
						role: "assistant",
						text: "먼저 기존 구현을 살펴보겠습니다.\n대화별 작업은 독립적으로 진행됩니다.",
					}}
				/>
				<Message
					message={{
						id: "3",
						role: "tool",
						toolName: "read",
						text: Array.from(
							{ length: 100 },
							(_, index) => `${index + 1}: 긴 출력과 경로 /packages/example/src/한국어-file.ts`,
						).join("\n"),
					}}
				/>
				<Message
					message={{
						id: "4",
						role: "tool",
						toolName: "bash",
						isError: true,
						text: "권한이 없어 명령을 실행하지 못했습니다.",
					}}
				/>
			</section>
			<section>
				<h2>질문</h2>
				{(["select", "confirm", "input", "editor"] as const).map(kind => (
					<QuestionCard
						key={kind}
						question={{
							id: kind,
							sessionId: "showcase",
							kind,
							title: `${kind} · 진행 방법을 선택하세요`,
							options: ["기존 구조 유지", "변경 검토"],
							initialValue: kind === "editor" ? "여러 줄 편집\n검토 내용" : "",
							message: "실제 질문에서는 답변이 호스트에 전달됩니다.",
						}}
						onAnswer={value => setAnswer(String(value))}
					/>
				))}
				<p role="status">{answer}</p>
			</section>
			<section>
				<h2>오류와 빈 상태</h2>
				<ErrorBanner>호스트 연결이 끊어졌습니다. 입력한 초안은 유지됩니다.</ErrorBanner>
				<div className="empty">아직 대화가 없습니다. 프로젝트에서 새 대화를 시작하세요.</div>
			</section>
			<section>
				<h2>입력 · 빈 값 / 초안 / 실행 중</h2>
				<Composer
					value={draft}
					onChange={setDraft}
					onSend={() => setAnswer("전송 예시")}
					onStop={() => setAnswer("중지 예시")}
					busy={false}
				/>
				<Composer
					value="실행 중에도 다음 메시지를 작성할 수 있습니다."
					onChange={() => {}}
					onSend={() => {}}
					onStop={() => setAnswer("중지 예시")}
					busy
				/>
				<Composer
					value="연결 실패 후 보존된 초안"
					onChange={() => {}}
					onSend={() => {}}
					onStop={() => {}}
					busy={false}
					disabled
				/>
			</section>
			<section>
				<h2>설정 필드</h2>
				<SettingField
					setting={{
						path: "example.mode",
						value: "safe",
						type: "string",
						writable: true,
						choices: ["safe", "review"],
					}}
					onSave={value => setAnswer(String(value))}
				/>
				<SettingField
					setting={{ path: "example.readonly", value: true, type: "boolean", writable: false }}
					onSave={() => {}}
				/>
				<p>지원되지 않음 · #7322 공개 SDK 지원 대기</p>
			</section>
			{dialog && (
				<Modal title="설정 · 키보드 포커스 검토" onClose={() => setDialog(false)}>
					<label>
						API 키<input type="password" autoComplete="off" />
					</label>
					<Button onClick={() => setDialog(false)}>닫기</Button>
				</Modal>
			)}
		</main>
	);
}
