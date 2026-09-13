"""로고에서 브랜드 팔레트를 뽑는다. 눈대중 대신 실제 픽셀을 센다."""
from collections import Counter

from PIL import Image

from pathlib import Path as _Path

# src/ 와 assets/ 는 형제 디렉토리. 클론한 곳이 어디든 동작한다.
_HERE = _Path(__file__).resolve().parent
def _asset(name):
    """에셋 경로를 푼다.

    1) 이 폴더의 assets/ — 로컬 작업본
    2) 저장소 루트의 assets/ — docs/cheatsheet 로 배포됐을 때.
       character.png·logo-vertical.png 는 루트에 이미 있으므로
       중복 사본을 두지 않는다.
    """
    for base in (_HERE.parent / "assets", _HERE.parents[2] / "assets"):
        p = base / name
        if p.exists():
            return str(p)
    raise FileNotFoundError(f"에셋을 찾을 수 없다: {name}")


im = Image.open(_asset("logo-vertical.png")).convert("RGBA")
w, h = im.size
px = im.load()

counts = Counter()
for y in range(0, h, 3):
    for x in range(0, w, 3):
        r, g, b, a = px[x, y]
        if a < 200:
            continue
        # 거의 흰색/검정은 배경·외곽선이라 제외
        if r > 235 and g > 235 and b > 235:
            continue
        if r < 40 and g < 40 and b < 40:
            continue
        counts[(r // 12 * 12, g // 12 * 12, b // 12 * 12)] += 1

print("상위 색상 (RGB / HEX / 비율)")
total = sum(counts.values())
for (r, g, b), n in counts.most_common(14):
    print("  (%3d,%3d,%3d)  #%02X%02X%02X  %5.2f%%" % (r, g, b, r, g, b, n / total * 100))
