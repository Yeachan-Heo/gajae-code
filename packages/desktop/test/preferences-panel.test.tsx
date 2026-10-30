import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopPreferences } from "../../desktop-host/src/preferences-protocol";
import { PreferencesPanel, type PreferencesPanelProps } from "../src/PreferencesPanel";

// Browser-safe presentation inputs only; no SDK/backend implementation is replaced.
function preferences(): DesktopPreferences {
	return {
		profiles: [
			{
				id: "configured-review",
				name: "공통 검토 프로필",
				description: null,
				source: "configured",
				active: true,
				default: false,
				capabilities: {
					selectSession: { available: true, reason: null },
					persistDefault: { available: false, reason: "Default-profile ownership CAS is unavailable." },
				},
			},
			{
				id: "builtin-review",
				name: "공통 검토 프로필",
				description: null,
				source: "builtin",
				active: false,
				default: true,
				capabilities: {
					selectSession: { available: true, reason: null },
					persistDefault: { available: false, reason: "Default-profile ownership CAS is unavailable." },
				},
			},
			{
				id: "unavailable-profile",
				name: "연결 대기 프로필",
				description: "설정에 있는 프로필 설명",
				source: "configured",
				active: false,
				default: false,
				capabilities: {
					selectSession: { available: false, reason: "Session selection requires an available host." },
					persistDefault: { available: false, reason: "Default-profile ownership CAS is unavailable." },
				},
			},
		],
		roles: [
			{
				id: "executor",
				name: "실행 담당",
				configured: true,
				model: { id: "shared-model", provider: "provider-a", name: "공통 모델" },
				thinkingLevel: "high",
				configurationResolution: { origin: "layered", layers: ["global", "project", "runtime"] },
				canApply: { available: true, reason: null },
				scope: "session",
				canClear: { available: true, reason: null },
			},
			{
				id: "critic",
				name: "검토 담당",
				configured: false,
				model: { id: "shared-model", provider: "provider-b", name: "공통 모델" },
				thinkingLevel: null,
				configurationResolution: { origin: "default", layers: [] },
				canApply: { available: false, reason: "Role unavailable." },
				scope: null,
				canClear: { available: false, reason: "No session-owned role choice is present." },
			},
		],
		sampling: [
			{
				parameter: "temperature",
				configuredValue: 0,
				effectiveValue: 0,
				mode: "value",
				resolution: { origin: "runtime", layers: ["global", "runtime"] },
				application: "next-run",
				modelSupport: "unknown",
				canApply: { available: false, reason: "Sampling validation and model capabilities are unavailable." },
			},
			{
				parameter: "topK",
				configuredValue: -1,
				effectiveValue: null,
				mode: "provider-default",
				resolution: { origin: "project", layers: ["global", "project"] },
				application: "next-run",
				modelSupport: "unknown",
				canApply: { available: false, reason: "Sampling validation and model capabilities are unavailable." },
			},
			{
				parameter: "topP",
				configuredValue: null,
				effectiveValue: null,
				mode: "invalid",
				resolution: { origin: "global", layers: ["global"] },
				application: "next-run",
				modelSupport: "unknown",
				canApply: { available: false, reason: "Sampling validation and model capabilities are unavailable." },
			},
		],
	};
}

function render(overrides: Partial<PreferencesPanelProps> = {}): string {
	return renderToStaticMarkup(
		<PreferencesPanel
			preferences={preferences()}
			onRefresh={() => { throw new Error("Rendering must not refresh preferences"); }}
			onApply={() => { throw new Error("Rendering must not apply preferences"); }}
			{...overrides}
		/>,
	);
}

function profileOptions(html: string): string[] {
	return html.match(/<li class="profile-option"[\s\S]*?<\/li>/gu) ?? [];
}

function preferenceRows(html: string): string[] {
	return html.match(/<li class="preference-row"[\s\S]*?<\/li>/gu) ?? [];
}

describe("desktop preferences presentation", () => {
	test("keeps actual active and saved-default states independent and disambiguates equal profile names", () => {
		const html = render();
		const [active, savedDefault, unavailable] = profileOptions(html);
		expect(active).toContain('data-active="true"');
		expect(active).not.toContain('data-default="true"');
		expect(active).toContain("이 대화에서 사용 중");
		expect(active).toContain("사용자 설정");
		expect(active).toContain("<code>configured-review</code>");
		expect(savedDefault).toContain('data-default="true"');
		expect(savedDefault).not.toContain('data-active="true"');
		expect(savedDefault).toContain("저장된 기본 프로필");
		expect(savedDefault).toContain("기본 제공");
		expect(savedDefault).toContain("<code>builtin-review</code>");
		expect(active).toContain("공통 검토 프로필 (configured-review): 이 대화에 적용");
		expect(savedDefault).toContain("공통 검토 프로필 (builtin-review): 이 대화에 적용");
		expect(unavailable).not.toContain('data-active="true"');
		expect(unavailable).not.toContain('data-default="true"');
		expect(unavailable).toContain("설정에 있는 프로필 설명");
	});

	test("disables unsupported scope actions with their original scoped reasons, without withholding session selection", () => {
		const html = render();
		const [active, savedDefault, unavailable] = profileOptions(html);
		const sessionButton = savedDefault?.match(/<button[^>]*aria-label="[^"]*: 이 대화에 적용"[^>]*>/u)?.[0];
		expect(sessionButton).toBeDefined();
		expect(sessionButton).not.toContain('disabled=""');
		expect(active).toMatch(/<button[^>]*aria-label="[^"]*: 기본 프로필로 저장"[^>]*disabled=""/u);
		expect(unavailable).toMatch(/<button[^>]*aria-label="[^"]*: 이 대화에 적용"[^>]*disabled=""/u);
		expect(unavailable).toMatch(/<button[^>]*aria-label="[^"]*: 기본 프로필로 저장"[^>]*disabled=""/u);
		expect(unavailable).toContain("이 대화: Session selection requires an available host.");
		expect(unavailable).toContain("기본값 저장: Default-profile ownership CAS is unavailable.");
		expect(html).toContain("최근 사용 모델(MRU) 기록은 공유 저장소에 쓰일 수 있습니다.");
		expect(html).toContain("대화에 적용해도 저장된 기본 프로필은 바뀌지 않습니다.");
	});

	test("renders resolved role identities, configuration state, thinking and map provenance as read-only", () => {
		const [executor, critic] = preferenceRows(render());
		expect(executor).toContain("명시적으로 설정됨");
		expect(executor).toContain("공통 모델");
		expect(executor).toContain("provider-a / shared-model");
		expect(executor).toContain("<dt>추론 수준</dt><dd>high</dd>");
		expect(executor).toContain("여러 계층 (layered)");
		expect(executor).toContain("전역 (global) → 프로젝트 (project) → 실행 중 (runtime)");
		expect(executor).toContain("모델 선택에서 변경 · 현재 대화에만 적용");
		expect(executor).not.toContain("<button");
		expect(critic).toContain("상속 또는 기본값");
		expect(critic).toContain("provider-b / shared-model");
		expect(critic).toContain("<dt>추론 수준</dt><dd>설정 없음</dd>");
		expect(critic).toContain("기본값 (default)");
		expect(critic).toContain("변경 불가: Role unavailable.");
		expect(critic).not.toContain("<button");
		expect(render()).toContain("역할 맵의 출처는 개별 역할 설정의 소유권을 뜻하지 않습니다.");
	});

	test("labels durable default model capability without adding another role editor", () => {
		const data = preferences();
		data.roles[0]!.id = "default";
		data.roles[0]!.scope = "default";
		data.roles[0]!.canClear = { available: false, reason: "The default model cannot be cleared." };
		const row = preferenceRows(render({ preferences: data }))[0];
		expect(row).toContain("모델 선택에서 변경 · 공통 설정에 저장");
		expect(row).not.toContain("<button");
	});

	test("preserves zero, provider-default -1, invalid values and next-run semantics without inferring provider support", () => {
		const html = render();
		const [, , zero, sentinel, invalid] = preferenceRows(html);
		expect(zero).toContain("<dt>병합된 설정 값</dt><dd>0</dd>");
		expect(zero).toContain("<dt>다음 실행 옵션 값</dt><dd>0</dd>");
		expect(zero).toContain("실행 중 (runtime)");
		expect(sentinel).toContain("<dd>-1 · 제공자 기본값 (-1)</dd>");
		expect(sentinel).toContain("<dt>다음 실행 옵션 값</dt><dd>명시적 옵션 값 없음</dd>");
		expect(sentinel).toContain("프로젝트 (project)");
		expect(invalid).toContain("값 없음 · 유효하지 않은 설정");
		expect(invalid).not.toContain("제공자 기본값 (-1)");
		for (const row of [zero, sentinel, invalid]) {
			expect(row).toContain("알 수 없음 (unknown)");
			expect(row).toContain("Sampling validation and model capabilities are unavailable.");
			expect(row).toMatch(/<button[^>]*disabled=""[^>]*>샘플링 변경 불가<\/button>/u);
		}
		expect(html).toContain("다음 실행의 에이전트 옵션 값입니다.");
		expect(html).toContain("실제 제공자 요청에 포함되거나 제공자가 수락한다는 뜻은 아닙니다.");
		expect(html).not.toContain("<input");
		expect(html).not.toContain("<select");
	});

	test("distinguishes unloaded, loading, failed, empty and idle states without optimistic application notices", () => {
		const unloaded = render({ preferences: null });
		expect(unloaded).toContain("환경설정 정보가 아직 없습니다.");
		expect(unloaded).not.toContain('role="status"');
		const loading = render({ preferences: null, pending: true });
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain('role="status"');
		expect(loading).toContain("환경설정을 불러오는 중…");
		expect(loading).not.toContain("환경설정 정보가 아직 없습니다.");
		const failed = render({ preferences: null, error: "호스트 응답을 받지 못했습니다." });
		expect(failed).toContain('role="alert"');
		expect(failed).toContain("호스트 응답을 받지 못했습니다.");
		expect(failed).not.toContain("불러오는 중");
		expect(failed).not.toContain("환경설정 정보가 아직 없습니다.");
		const empty = render({ preferences: { profiles: [], roles: [], sampling: [] } });
		expect(empty).toContain("사용 가능한 모델 프로필이 없습니다.");
		expect(empty).toContain("역할별 모델 정보가 없습니다.");
		expect(empty).toContain("샘플링 설정 정보가 없습니다.");
		const idle = render();
		expect(idle).toContain('aria-busy="false"');
		expect(idle).not.toContain('role="status"');
		expect(idle).not.toContain('role="alert"');
		expect(idle).not.toContain("적용 완료");
	});

	test("locks every action while pending and retains authoritative values and visible errors", () => {
		const html = render({ pending: true, error: "프로필 변경 요청이 거부되었습니다." });
		const buttons = html.match(/<button\b[^>]*>/gu) ?? [];
		expect(buttons.length).toBeGreaterThan(0);
		for (const button of buttons) expect(button).toContain('disabled=""');
		expect(html).toContain("설정 연결 또는 요청 처리를 기다리는 중…");
		expect(html).toContain("프로필 변경 요청이 거부되었습니다.");
		expect(html).toContain("아래는 마지막으로 받은 값입니다.");
		expect(profileOptions(html)[0]).toContain('data-active="true"');
		expect(profileOptions(html)[1]).not.toContain('data-active="true"');
		expect(html).not.toContain("설정이 적용되었습니다");
	});

	test("blocks profile writes while the selected session is busy without blocking refresh or read-only inspection", () => {
		const html = render({ busy: true });
		const refreshButton = html.match(/<button\b[^>]*>[\s\S]*?새로고침<\/button>/u)?.[0];
		expect(refreshButton).toBeDefined();
		expect(refreshButton).not.toContain('disabled=""');
		expect(html).toContain('aria-busy="false"');
		expect(html).not.toContain("설정 연결 또는 요청 처리를 기다리는 중");
		expect(html).toContain("변경은 현재 작업이 끝난 뒤 다시 요청하세요.");
		expect(html).toContain("요청이 자동으로 예약되지는 않습니다.");
		for (const profile of profileOptions(html)) {
			const buttons = profile.match(/<button\b[^>]*>/gu) ?? [];
			expect(buttons).toHaveLength(2);
			for (const button of buttons) {
				expect(button).toContain('disabled=""');
				expect(button).toMatch(/aria-describedby="[^"]* [^"]*-busy"/u);
			}
		}
		expect(preferenceRows(html)).toEqual(preferenceRows(render()));
		expect(render({ busy: true, pending: true })).toMatch(/<button\b[^>]*disabled=""[^>]*>[\s\S]*?새로고침<\/button>/u);
	});

	test("does not invent active/default profiles or resolved models when the DTO has none", () => {
		const data = preferences();
		for (const profile of data.profiles) {
			profile.active = false;
			profile.default = false;
		}
		data.roles[0]!.model = null;
		const html = render({ preferences: data });
		expect(html).not.toContain('data-active="true"');
		expect(html).not.toContain('data-default="true"');
		expect(html).not.toContain("이 대화에서 사용 중");
		expect(html).not.toContain("저장된 기본 프로필</span>");
		expect(preferenceRows(html)[0]).toContain("해석된 모델 없음");
		expect(preferenceRows(html)[0]).not.toContain("provider-a");
	});

	test("escapes untrusted profile, model, reason and error labels instead of interpreting HTML", () => {
		const data = preferences();
		const hostile = '<img src=x onerror="alert(1)">';
		data.profiles[0]!.name = hostile;
		data.profiles[0]!.id = hostile;
		data.profiles[0]!.description = hostile;
		data.profiles[0]!.capabilities.persistDefault.reason = hostile;
		data.roles[0]!.name = hostile;
		data.roles[0]!.model = { id: hostile, name: hostile, provider: hostile };
		data.roles[0]!.canApply.reason = hostile;
		data.sampling[0]!.canApply.reason = hostile;
		const html = render({ preferences: data, error: hostile });
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(html).not.toContain("<img");
		expect(html).not.toContain(hostile);
		expect(html).toContain('role="alert"');
	});
});
