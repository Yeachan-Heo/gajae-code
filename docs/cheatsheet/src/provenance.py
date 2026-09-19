"""파생 에셋의 출처를 기록·검증한다.

문제: 워크플로 다이어그램은 4단계를 거친다.

    PaperBanana -> pb_workflow.png
                -> pb_workflow_crop.png          (크롭)
                -> pb_workflow_{ko,en}.png       (OpenAI 이미지 편집)
                -> pb_workflow_{ko,en}_crop.png  (크롭)
                -> 치트시트

각 단계가 따로 실행되는 스크립트라, 상류만 다시 돌리고 하류를 안 돌리면
낡은 중간 산출물이 그대로 쓰인다. 눈으로는 알아챌 수 없다 —
이미지가 그럴듯하게 나오기 때문이다.

그래서 파생물마다 '어떤 입력에서 나왔는지'를 해시로 남긴다.
입력이 바뀌었는데 파생물이 안 바뀌었으면 stale 로 잡힌다.
"""
import hashlib
import json
from pathlib import Path

MANIFEST = "pipeline.json"


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _path(assets):
    return Path(assets) / MANIFEST


def load(assets):
    p = _path(assets)
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def record(assets, output, *inputs):
    """output 이 inputs 에서 파생됐음을 기록한다."""
    assets = Path(assets)
    data = load(assets)
    data[Path(output).name] = {
        "inputs": {Path(i).name: digest(i) for i in inputs},
        "self": digest(assets / Path(output).name
                       if not Path(output).is_absolute() else output),
    }
    _path(assets).write_text(
        json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8")


def check(assets, output):
    """output 의 기록된 입력 해시가 현재 파일과 일치하는지 본다.

    반환: (ok, 사유). 기록이 없으면 (False, 'no record').
    """
    assets = Path(assets)
    data = load(assets)
    rec = data.get(Path(output).name)
    if not rec:
        return False, "계보 기록 없음"
    for name, want in rec.get("inputs", {}).items():
        p = assets / name
        if not p.exists():
            return False, f"입력 없음: {name}"
        if digest(p) != want:
            return False, f"입력이 바뀌었다: {name} (파생물이 낡음)"
    out = assets / Path(output).name
    if not out.exists():
        return False, "산출물 없음"
    if rec.get("self") and digest(out) != rec["self"]:
        return False, "산출물이 기록 이후 변경됨"
    return True, "ok"


def verify_chain(assets, chain):
    """chain: [(출력, [입력...]), ...] 순서대로 검사하고 결과를 출력한다."""
    ok_all = True
    for out, _ in chain:
        ok, why = check(assets, out)
        print(f"  {'OK  ' if ok else 'STALE'}  {out:<28} {'' if ok else why}")
        ok_all &= ok
    return ok_all
