"""영문 워크플로 다이어그램의 단계 번호 오류를 바로잡는다.

원본(PaperBanana)은 승인 게이트를 번호 없는 다이아몬드로 그려놓고
마지막 박스를 "Stage 4" 로 적었다. 3단계 박스가 없으니 번호가 어긋난다.
한글판과 동일한 경로(OpenAI Image 2.5 편집)로 다시 그려 짝을 맞춘다.
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

IMPORTANT: the last box must read "Stage 3", not "Stage 4". The original is
wrong because the approval gate is an unnumbered diamond, so there is no
Stage 3 box and the numbering skips. Fix it.
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
