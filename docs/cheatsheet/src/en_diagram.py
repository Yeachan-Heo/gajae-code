"""영문 워크플로 다이어그램을 그린다.

번호 계약: 박스는 1·2·3 세 개뿐이고 승인 게이트는 번호가 없다.
gen_workflow.py 의 method 텍스트와 같은 계약이다.

(이력: PaperBanana 1차 출력은 게이트를 번호 없이 그려놓고 마지막 박스를
"Stage 4" 로 적어 번호가 어긋났다. gen_workflow.py 를 고쳐 상류에서
막았고, 이 프롬프트는 같은 계약을 재확인한다.)
"""
import base64
import os
import sys

import requests

from pathlib import Path as _Path

# src/ 와 assets/ 는 형제 디렉토리. 클론한 곳이 어디든 동작한다.
_ASSETS = _Path(__file__).resolve().parent.parent / "assets"


SRC = str(_ASSETS / "pb_workflow_crop.png")
DST = str(_ASSETS / "pb_workflow_en.png")
MODEL = sys.argv[1] if len(sys.argv) > 1 else "gpt-image-2.5-sunburst"

PROMPT = """\
Redraw this diagram keeping the layout, colors, shapes and arrow directions
identical to the original. Warm orange/red palette, white background, dark
charcoal text, rounded rectangular boxes. All text must be crisp and correct.

Labels, left to right:

- Speech bubble: "Vague user request"
- First box title: "Stage 1 - deep-interview"
  body: "Asks questions & writes requirements"
  document icon label: "Concrete Requirements Spec"
- Second box title: "Stage 2 - ralplan"
  body: "Implementation plan + Adversarial critique"
  document icon label: "Reconciled Plan Receipt"
- Red diamond: "APPROVAL GATE" / "no mutation before this point"
- Last box title: "Stage 3 - ultragoal"
  body: "Execution, Revision, Verification, Evidence"
- Dashed box below: "autoresearch (optional)"
- Next to the dashed arrow: "feeds evidence"
- Bottom-right cluster title: "Role Agents"
  four cells: "executor (writes code)", "architect (read-only review)",
              "planner (sequencing)", "critic (plan critique)"

IMPORTANT: there are exactly three numbered boxes (1, 2, 3). The approval gate
is a decision diamond and carries no stage number, so the numbering must not
skip: the last box reads "Stage 3", never "Stage 4".
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
        open(DST, "wb").write(requests.get(payload["url"], timeout=180).content)
    print("saved:", DST, os.path.getsize(DST), "bytes")


if __name__ == "__main__":
    main()
