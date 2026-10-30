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

export interface PreferencesPanelProps {
	preferences: DesktopPreferences | null;
	pending?: boolean;
	busy?: boolean;
	error?: string;
	onRefresh: () => void;
	onApply: (action: DesktopPreferenceAction) => void;
}

const originLabels = {
	default: "기본값",
	global: "전역",
	project: "프로젝트",
	runtime: "실행 중",
	layered: "여러 계층",
};

function Resolution({ resolution }: { resolution: DesktopPreferenceResolution }) {
	return (
		<>
			{originLabels[resolution.origin]} ({resolution.origin})
			{resolution.layers.length > 0 && (
				<> · 계층: {resolution.layers.map(layer => `${originLabels[layer]} (${layer})`).join(" → ")}</>
			)}
		</>
	);
}

function ProfileOption({
	profile,
	pending,
	busy,
	busyReasonId,
	onApply,
}: {
	profile: DesktopModelProfile;
	pending?: boolean;
	busy?: boolean;
	busyReasonId: string;
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
				<span>{profile.source === "configured" ? "사용자 설정" : "기본 제공"}</span>
				{profile.active && (
					<span>
						<Check size={14} aria-hidden="true" />이 대화에서 사용 중
					</span>
				)}
				{profile.default && <span>저장된 기본 프로필</span>}
			</div>
			<h4>{profile.name}</h4>
			<p className="preference-value">
				<code>{profile.id}</code>
			</p>
			{profile.description && <p className="muted">{profile.description}</p>}
			<div className="preference-actions actions">
				<Button
					aria-label={`${profile.name} (${profile.id}): 이 대화에 적용`}
					aria-pressed={profile.active}
					aria-describedby={`${id}-session${busy ? ` ${busyReasonId}` : ""}`}
					disabled={pending || busy || !session.available || profile.active}
					onClick={() => {
						if (!pending && !busy && session.available && !profile.active) {
							onApply({ type: "profile.select", name: profile.id, scope: "session" });
						}
					}}
				>
					{profile.active ? "현재 대화 프로필" : "이 대화에 적용"}
				</Button>
				<Button
					aria-label={`${profile.name} (${profile.id}): 기본 프로필로 저장`}
					aria-pressed={profile.default}
					aria-describedby={`${id}-default${busy ? ` ${busyReasonId}` : ""}`}
					disabled={pending || busy || !persisted.available || profile.default}
					onClick={() => {
						if (!pending && !busy && persisted.available && !profile.default) {
							onApply({ type: "profile.select", name: profile.id, scope: "default" });
						}
					}}
				>
					{profile.default ? "저장된 기본 프로필" : "기본 프로필로 저장"}
				</Button>
			</div>
			<p id={`${id}-session`} className="preference-reason">
				이 대화:{" "}
				{session.reason ??
					(session.available
						? "적용 시 자격 증명과 실제 모델을 확인합니다."
						: "프로필 선택을 사용할 수 없습니다.")}
			</p>
			<p id={`${id}-default`} className="preference-reason">
				기본값 저장:{" "}
				{persisted.reason ??
					(persisted.available
						? "공유 설정의 기본 프로필을 변경합니다."
						: "안전한 기본 프로필 저장 기능을 사용할 수 없습니다.")}
			</p>
		</li>
	);
}

function RolePreference({ role }: { role: DesktopModelRolePreference }) {
	return (
		<li className="preference-row">
			<h4>
				{role.name} <small>({role.id})</small>
			</h4>
			<dl>
				<div>
					<dt>설정 상태</dt>
					<dd>{role.configured ? "명시적으로 설정됨" : "상속 또는 기본값"}</dd>
				</div>
				<div>
					<dt>현재 해석된 모델</dt>
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
							"해석된 모델 없음"
						)}
					</dd>
				</div>
				<div>
					<dt>추론 수준</dt>
					<dd>{role.thinkingLevel ?? "설정 없음"}</dd>
				</div>
				<div>
					<dt>역할 맵 출처</dt>
					<dd>
						<Resolution resolution={role.configurationResolution} />
					</dd>
				</div>
			</dl>
			<p className="preference-reason">
				{role.canApply.available
					? role.scope === "default"
						? "모델 선택에서 변경 · 공통 설정에 저장"
						: "모델 선택에서 변경 · 현재 대화에만 적용"
					: `변경 불가: ${role.canApply.reason ?? "이 역할은 변경할 수 없습니다."}`}
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
					<dt>병합된 설정 값</dt>
					<dd>
						{sampling.configuredValue ?? "값 없음"}
						{sampling.mode === "provider-default" && " · 제공자 기본값 (-1)"}
						{sampling.mode === "invalid" && " · 유효하지 않은 설정"}
					</dd>
				</div>
				<div>
					<dt>다음 실행 옵션 값</dt>
					<dd>{sampling.effectiveValue ?? "명시적 옵션 값 없음"}</dd>
				</div>
				<div>
					<dt>설정 출처</dt>
					<dd>
						<Resolution resolution={sampling.resolution} />
					</dd>
				</div>
				<div>
					<dt>모델별 지원 여부</dt>
					<dd>알 수 없음 (unknown)</dd>
				</div>
			</dl>
			<Button disabled aria-describedby={id}>
				샘플링 변경 불가
			</Button>
			<p id={id} className="preference-reason">
				읽기 전용:{" "}
				{sampling.canApply.reason ?? "공개 SDK에 모델별 샘플링 지원 정보와 안전한 값 검증·변경 기능이 없습니다."}
			</p>
		</li>
	);
}

export function PreferencesPanel({
	preferences,
	pending = false,
	busy = false,
	error,
	onRefresh,
	onApply,
}: PreferencesPanelProps) {
	const id = useId();
	return (
		<section className="preferences-panel" aria-labelledby={`${id}-title`} aria-busy={pending}>
			<div className="preferences-toolbar">
				<div>
					<h2 id={`${id}-title`}>모델 환경설정</h2>
					<p className="muted">현재 대화의 프로필, 역할 모델과 샘플링 설정을 확인하세요.</p>
				</div>
				<Button disabled={pending} onClick={onRefresh}>
					<RefreshCw aria-hidden="true" />
					새로고침
				</Button>
			</div>
			{error && <ErrorBanner>{error}</ErrorBanner>}
			{pending && (
				<p className="preference-reason" role="status">
					{preferences
						? "설정 연결 또는 요청 처리를 기다리는 중… 아래는 마지막으로 받은 값입니다."
						: "환경설정을 불러오는 중…"}
				</p>
			)}
			{!preferences && !pending && !error && (
				<p className="empty model-empty">환경설정 정보가 아직 없습니다. 새로고침으로 불러오세요.</p>
			)}
			{preferences && (
				<>
					{error && (
						<p className="preference-reason">
							아래는 마지막으로 받은 값입니다. 오류 메시지는 설정 적용 완료를 뜻하지 않습니다.
						</p>
					)}
					<section className="preferences-group" aria-labelledby={`${id}-profiles`}>
						<h3 id={`${id}-profiles`}>모델 프로필</h3>
						{busy && (
							<p id={`${id}-busy`} className="preference-reason">
								변경은 현재 작업이 끝난 뒤 다시 요청하세요. 실행 중이거나 응답을 기다리는 동안에는 프로필을
								변경할 수 없습니다. 요청이 자동으로 예약되지는 않습니다.
							</p>
						)}
						<p className="preference-reason">
							대화에 적용해도 저장된 기본 프로필은 바뀌지 않습니다. 단, SDK의 최근 사용 모델(MRU) 기록은 공유
							저장소에 쓰일 수 있습니다.
						</p>
						{preferences.profiles.length === 0 ? (
							<p className="empty model-empty">사용 가능한 모델 프로필이 없습니다.</p>
						) : (
							<ul className="preference-grid" aria-label="모델 프로필 목록">
								{preferences.profiles.map(profile => (
									<ProfileOption
										key={profile.id}
										profile={profile}
										pending={pending}
										busy={busy}
										busyReasonId={`${id}-busy`}
										onApply={onApply}
									/>
								))}
							</ul>
						)}
					</section>
					<section className="preferences-group" aria-labelledby={`${id}-roles`}>
						<h3 id={`${id}-roles`}>역할별 모델</h3>
						<p className="preference-reason">
							현재 해석된 값만 표시합니다. 역할 맵의 출처는 개별 역할 설정의 소유권을 뜻하지 않습니다.
						</p>
						{preferences.roles.length === 0 ? (
							<p className="empty model-empty">역할별 모델 정보가 없습니다.</p>
						) : (
							<ul className="preference-grid" aria-label="역할별 모델 목록">
								{preferences.roles.map(role => (
									<RolePreference key={role.id} role={role} />
								))}
							</ul>
						)}
					</section>
					<section className="preferences-group" aria-labelledby={`${id}-sampling`}>
						<h3 id={`${id}-sampling`}>샘플링</h3>
						<p className="preference-reason">
							다음 실행의 에이전트 옵션 값입니다. 실제 제공자 요청에 포함되거나 제공자가 수락한다는 뜻은
							아닙니다. 모델별 지원 여부는 알 수 없습니다.
						</p>
						{preferences.sampling.length === 0 ? (
							<p className="empty model-empty">샘플링 설정 정보가 없습니다.</p>
						) : (
							<ul className="preference-grid" aria-label="샘플링 설정 목록">
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
