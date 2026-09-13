"""PaperBanana 가 만든 영문 워크플로 다이어그램을 한글판으로 변환한다.

OpenAI Image 2.5 의 이미지 편집 엔드포인트를 쓴다.
원본 레이아웃·색·구조를 유지하고 라벨만 한국어로 바꾸는 게 목표다.

입력 이미지는 gen_workflow.py 가 PaperBanana 로 만든 것이다.
PaperBanana 원본: https://github.com/dwzhu-pku/PaperBanana


번호 계약: 박스는 1·2·3 세 개뿐이고 승인 게이트는 번호가 없다.
gen_workflow.py 의 method 텍스트와 같은 계약이다.
"""
import base64
import os
import sys

import requests

from pathlib import Path as _Path

# src/ 와 assets/ 는 형제 디렉토리. 클론한 곳이 어디든 동작한다.
_ASSETS = _Path(__file__).resolve().parent.parent / "assets"


SRC = str(_ASSETS / "pb_workflow_crop.png")
DST = str(_ASSETS / "pb_workflow_ko.png")
MODEL = sys.argv[1] if len(sys.argv) > 1 else "gpt-image-2.5-sunburst"

PROMPT = """\
이 다이어그램을 그대로 다시 그리되, 모든 텍스트를 한국어로 바꿔라.

레이아웃·색상·도형·화살표 방향을 원본과 동일하게 유지한다.
따뜻한 주황/빨강 계열, 흰 배경, 진한 회색 글자, 둥근 사각형 박스.
글자는 또렷하고 정확한 한글이어야 한다. 깨진 글자나 의미 없는 획은 금지.

왼쪽에서 오른쪽으로 이어지는 라벨:

- 말풍선: "모호한 요청"
- 1단계 박스 제목: "1단계 — deep-interview"
  본문: "질문하고 요구사항을 적는다"
  문서 아이콘 라벨: "구체화된 요구 명세"
- 2단계 박스 제목: "2단계 — ralplan"
  본문: "구현 계획 + 반대 비판"
  문서 아이콘 라벨: "조정된 계획 영수증"
- 빨간 다이아몬드: "승인 게이트" / "이 지점 전에는 변경 금지"
- 마지막 박스 제목: "3단계 — ultragoal"
  본문: "실행 · 수정 · 검증 · 증거"
- 아래쪽 점선 박스: "autoresearch (선택)"
- 점선 화살표 옆: "근거 제공"
- 오른쪽 아래 묶음 제목: "역할 에이전트"
  네 칸: "executor (코드 작성)", "architect (읽기 전용 리뷰)",
        "planner (순서 설계)", "critic (계획 비판)"

중요: 번호가 붙은 박스는 1·2·3 셋뿐이다. 승인 게이트는 결정 지점이라
번호가 없으므로 번호를 건너뛰면 안 된다. 마지막 박스는 "3단계"다.
"""


def main():
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise SystemExit("OPENAI_API_KEY 없음")

    with open(SRC, "rb") as f:
        files = {"image": ("diagram.png", f.read(), "image/png")}
    data = {"model": MODEL, "prompt": PROMPT, "size": "1536x1024"}

    print(f"model={MODEL}  size=1536x1024")
    r = requests.post("https://api.openai.com/v1/images/edits",
                      headers={"Authorization": f"Bearer {key}"},
                      data=data, files=files, timeout=600)
    print("HTTP", r.status_code)
    if r.status_code != 200:
        print(r.text[:1200])
        raise SystemExit(1)

    payload = r.json()["data"][0]
    blob = payload.get("b64_json")
    if blob:
        open(DST, "wb").write(base64.b64decode(blob))
    else:
        img = requests.get(payload["url"], timeout=180)
        open(DST, "wb").write(img.content)
    print("saved:", DST, os.path.getsize(DST), "bytes")


if __name__ == "__main__":
    main()
