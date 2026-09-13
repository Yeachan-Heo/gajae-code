"""이미지의 흰 여백을 잘라낸다.

순백이 아니라 253,253,253 같은 값이 섞여 있어 getbbox() 는 못 쓴다.
채널 합 기준 관용 오차로 진짜 내용 범위를 잡는다.

    python3 crop.py <입력> [출력]
"""
import sys

import numpy as np
from PIL import Image


def crop(src, dst=None, pad=10, tol=24):
    dst = dst or src.replace(".png", "_crop.png")
    im = Image.open(src).convert("RGB")
    arr = np.asarray(im).astype(int)
    mask = (255 - arr).sum(axis=2) > tol
    ys, xs = np.where(mask)
    box = (max(0, xs.min() - pad), max(0, ys.min() - pad),
           min(im.width, xs.max() + pad), min(im.height, ys.max() + pad))
    im.crop(box).save(dst)
    out = Image.open(dst)
    print(f"{src}\n  {im.size} -> {out.size}  ratio {out.width / out.height:.2f}")
    return dst


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    crop(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
