"""macOS 시스템 폰트의 Bold face 를 matplotlib 에 등록한다.

Apple SD Gothic Neo · Helvetica Neue · Menlo 는 전부 .ttc 컬렉션이고,
matplotlib 의 폰트 매니저는 컬렉션에서 face 0(Regular)만 읽는다.
그 결과 fontweight="bold" 를 줘도 조용히 Regular 로 떨어진다 — 경고도 없다.

컬렉션 안에 Bold face 는 실제로 들어 있으므로, 그것만 단일 .ttf 로 뽑아
런타임에 등록한다. 추출본은 사용자 캐시에 두고 배포물에는 넣지 않는다.
"""
from pathlib import Path

from matplotlib import font_manager as fm

CACHE = Path.home() / ".cache" / "gajae-cheatsheet-fonts"

# (컬렉션 경로, face 인덱스, 캐시 파일명)
FACES = [
    ("/System/Library/Fonts/AppleSDGothicNeo.ttc", 6, "AppleSDGothicNeo-Bold.ttf"),
    ("/System/Library/Fonts/HelveticaNeue.ttc", 1, "HelveticaNeue-Bold.ttf"),
    ("/System/Library/Fonts/Menlo.ttc", 1, "Menlo-Bold.ttf"),
]


def _extract(src, index, dst):
    from fontTools.ttLib import TTCollection
    coll = TTCollection(src)
    font = coll.fonts[index]
    font.flavor = None
    font.save(str(dst))


def ensure_bold():
    """등록된 Bold face 이름 목록을 반환. 실패해도 렌더는 계속된다."""
    CACHE.mkdir(parents=True, exist_ok=True)
    added = []
    for src, index, name in FACES:
        if not Path(src).exists():
            continue
        dst = CACHE / name
        if not dst.exists():
            try:
                _extract(src, index, dst)
            except Exception as exc:            # 폰트가 없거나 fontTools 부재
                print(f"  [fonts] {name} 추출 실패: {exc}")
                continue
        try:
            fm.fontManager.addfont(str(dst))
            added.append(name)
        except Exception as exc:
            print(f"  [fonts] {name} 등록 실패: {exc}")
    return added


def report():
    """가족별로 bold 가 실제로 해석되는지 확인한다."""
    rows = []
    for family in ("Apple SD Gothic Neo", "Helvetica Neue", "Menlo"):
        reg = fm.findfont(fm.FontProperties(family=family, weight="normal"))
        bold = fm.findfont(fm.FontProperties(family=family, weight="bold"))
        rows.append((family, Path(reg).name, Path(bold).name, reg != bold))
    return rows


if __name__ == "__main__":
    print("등록:", ensure_bold())
    for fam, reg, bold, ok in report():
        print(f"  {fam:<22} normal={reg:<28} bold={bold:<28} {'OK' if ok else '동일 — 실패'}")
