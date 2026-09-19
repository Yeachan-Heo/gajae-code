"""워크플로 다이어그램 생성 사슬을 한 곳에서 돌리고 검증한다.

    PaperBanana ─ gen_workflow.py ─→ pb_workflow.png
                                   └→ pb_workflow_crop.png      (하류 입력)
    OpenAI Image ─ ko_diagram.py ──→ pb_workflow_ko.png
                                   └→ pb_workflow_ko_crop.png   (치트시트 입력)
    OpenAI Image ─ en_diagram.py ──→ pb_workflow_en.png
                                   └→ pb_workflow_en_crop.png   (치트시트 입력)
    content.py ────────────────────→ 치트시트 8종

단계가 각각 다른 스크립트라 상류만 돌리고 하류를 빠뜨리기 쉽다.
그러면 낡은 중간 산출물이 조용히 그대로 쓰인다 — 이미지라서 눈으로는 모른다.
그래서 파생물마다 입력 해시를 남기고(provenance.py), 여기서 한 번에 검사한다.

    python3 src/pipeline.py verify   기존 에셋의 계보만 검사 (API 호출 없음)
    python3 src/pipeline.py run      상류부터 전부 재생성 (API 키 필요)
"""
import subprocess
import sys
from pathlib import Path

import provenance

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets"

# (산출물, 입력들) — 순서가 곧 의존 사슬이다.
CHAIN = [
    ("pb_workflow_crop.png", ["pb_workflow.png"]),
    ("pb_workflow_ko_crop.png", ["pb_workflow_crop.png", "pb_workflow_ko.png"]),
    ("pb_workflow_en_crop.png", ["pb_workflow_crop.png", "pb_workflow_en.png"]),
]

STEPS = [
    ("gen_workflow.py", "PaperBanana 로 워크플로 다이어그램 생성 + 크롭"),
    ("ko_diagram.py", "한국어판 생성 + 크롭"),
    ("en_diagram.py", "영문판 생성 + 크롭"),
]


def verify():
    print("계보 검사 (assets/pipeline.json 기준)")
    ok = provenance.verify_chain(str(ASSETS), CHAIN)
    print("\n  결과:", "전부 최신" if ok else "낡은 파생물 있음 — pipeline.py run 필요")
    return 0 if ok else 1


def run():
    for script, desc in STEPS:
        print(f"\n=== {script} — {desc}")
        r = subprocess.run([sys.executable, str(HERE / script)], cwd=str(HERE))
        if r.returncode != 0:
            print(f"  실패: {script}")
            return r.returncode
    print("\n=== content.py — 치트시트 렌더")
    r = subprocess.run([sys.executable, str(HERE / "content.py"),
                        str(HERE.parent)], cwd=str(HERE))
    if r.returncode != 0:
        return r.returncode
    print()
    return verify()


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "verify"
    if action == "verify":
        sys.exit(verify())
    if action == "run":
        sys.exit(run())
    raise SystemExit(__doc__)
