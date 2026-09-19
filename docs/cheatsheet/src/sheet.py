"""세로 스크롤용 치트시트 엔진.

구조: 페이지 → 그룹(주제) → 섹션 → 행.
그룹 박스를 정확히 닫으려면 배치 전에 높이를 알아야 하므로,
행 높이를 전부 해석적으로 계산한 뒤 2단으로 패킹한다.
좌표는 인치.
"""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.image as mpimg
from matplotlib.patches import FancyBboxPatch
from PIL import Image

import fonts as _fonts

# .ttc 안의 Bold face 를 등록한다. 이걸 안 하면 fontweight="bold" 가
# 조용히 Regular 로 떨어져 굵기가 아예 적용되지 않는다.
_fonts.ensure_bold()

# ── 용지: 1:3 세로 ──────────────────────────────────────────────────────
W = 8.27
H = W * 3
DPI = 300

_S = 2.0                       # 글자·여백 공통 배율
MARGIN = 0.26 * _S
GCOLS = 2                      # 그룹 내부 단 수
GPAD_X = 0.14 * _S                  # 그룹 박스 안쪽 좌우 여백
GPAD_TOP = 0.40 * _S                # 그룹 제목 높이
GPAD_BOT = 0.13 * _S
GGAP = 0.22 * _S                    # 그룹 사이 간격
COLGAP = 0.16 * _S

CONTENT_W = W - 2 * MARGIN
COLW = (CONTENT_W - 2 * GPAD_X - COLGAP * (GCOLS - 1)) / GCOLS


def set_scale(k, cols=None):
    """글자 배율과 단 수를 런타임에 바꾼다. A4 판처럼 지면이 고정된 경우
    내용을 줄이는 대신 배율·단수를 풀어서 맞춘다."""
    global _S, SCALE, MARGIN, GPAD_X, GPAD_TOP, GPAD_BOT, GGAP, COLGAP, GCOLS
    global S_GROUP, S_TITLE, S_CODE, S_DESC, S_TINY
    global LH_CODE, LH_DESC, LH_HEAD, RULE_PAD, PAD_L, PAD_R, BAR_H
    _S = SCALE = k
    MARGIN, GPAD_X = 0.26 * k, 0.14 * k
    GPAD_TOP, GPAD_BOT = 0.40 * k, 0.13 * k
    GGAP, COLGAP = 0.22 * k, 0.16 * k
    S_GROUP, S_TITLE, S_CODE = 12.0 * k, 8.2 * k, 6.3 * k
    S_DESC, S_TINY = 5.6 * k, 5.0 * k
    LH_CODE, LH_DESC, LH_HEAD = 0.107 * k, 0.094 * k, 0.245 * k
    RULE_PAD = 0.05 * k
    PAD_L, PAD_R, BAR_H = 0.055 * k, 0.05 * k, 0.185 * k
    if cols:
        GCOLS = cols
    set_width(W)


def set_width(w):
    """본문 줄 수는 고정이라 높이는 폭에 거의 무관하다.
    목표 비율을 맞추려면 높이를 재상하게 놓고 폭을 푸는 게 맞다."""
    global W, CONTENT_W, COLW
    W = w
    CONTENT_W = W - 2 * MARGIN
    COLW = (CONTENT_W - 2 * GPAD_X - COLGAP * (GCOLS - 1)) / GCOLS

# ── 팔레트 (로고 픽셀에서 추출) ──────────────────────────────────────────
ORANGE = "#FC3C00"
AMBER = "#F07800"
CORAL = "#FC4848"
MAROON = "#600000"
INK = "#241F1C"
GREY = "#7A7069"
LIGHT = "#EFEBE8"
GROUPBG = "#FCFAF9"
GROUPEDGE = "#E4DBD5"
HAIR = "#D8D0CA"

FONT_MONO = "Menlo"
FONT_SANS = "Apple SD Gothic Neo"
FONT_SANS_EN = "Helvetica Neue"

# 글자 2배. 행 높이도 같이 2배로 올려야 줄이 겹치지 않는다.
SCALE = _S

S_GROUP = 12.0 * SCALE
S_TITLE = 8.2 * SCALE
S_CODE = 6.3 * SCALE
S_DESC = 5.6 * SCALE
S_TINY = 5.0 * SCALE

LH_CODE = 0.107 * SCALE
LH_DESC = 0.094 * SCALE
LH_HEAD = 0.245 * SCALE
RULE_PAD = 0.05 * SCALE

# 박스 안쪽 여백도 글자에 맞춰 키운다.
PAD_L = 0.055 * SCALE
PAD_R = 0.05 * SCALE
BAR_H = 0.185 * SCALE


# ── 행 헬퍼 (데이터만 만든다) ───────────────────────────────────────────
def code(left, right=None, color=ORANGE, indent=0.0):
    return ("code", left, right, color, indent)


def line(text, color=INK, indent=0.0):
    return ("line", text, color, indent)


def desc(text, color=GREY, size=None):
    # size=S_DESC 로 두면 import 시점 값이 박혀 set_scale() 이 안 먹는다.
    # None 으로 받아 렌더 시점에 푼다.
    return ("desc", text, color, size)


def kv(k, v, split=0.52, vcolor=ORANGE):
    return ("kv", k, v, split, vcolor)


def gap(amount=0.10):
    return ("gap", amount * SCALE)


def rule():
    return ("rule",)


def img(path, max_h):
    return ("img", path, max_h * SCALE)


class Section:
    def __init__(self, title, rows, badge=None):
        self.title = title
        self.rows = rows
        self.badge = badge

    def row_height(self, r, width):
        k = r[0]
        if k in ("code", "line"):
            return LH_CODE
        if k in ("desc", "kv"):
            return LH_DESC
        if k == "gap":
            return r[1]
        if k == "rule":
            return 2 * RULE_PAD
        if k == "img":
            p = Path(r[1])
            if not p.exists():
                return 0.0
            iw, ih = Image.open(p).size
            w = width - 0.10
            h = w * ih / iw
            return min(h, r[2]) + 0.06 * SCALE
        return 0.0

    def height(self, width):
        return LH_HEAD + sum(self.row_height(r, width) for r in self.rows) + 0.10 * SCALE


# PDF 백엔드가 /CreationDate 에 빌드 시각을 박아 같은 입력에도 바이트가
# 달라진다. None 을 주면 그 키를 생략해 재생성이 바이트 동일해진다.
PDF_META = {"CreationDate": None}

_mfig = None


def text_width(txt, font, size, weight="normal"):
    """문자열의 실제 렌더 폭(인치). 추정 대신 폰트 메트릭을 직접 잴다."""
    global _mfig
    if _mfig is None:
        _mfig = plt.figure(figsize=(1, 1), dpi=DPI)
    r = _mfig.canvas.get_renderer()
    t = _mfig.text(0, 0, txt, fontfamily=font, fontsize=size, fontweight=weight)
    w = t.get_window_extent(renderer=r).width / DPI
    t.remove()
    return w


def overflow_rows(groups, sans):
    """단 폭을 넘는 좌측 정렬 행을 센다. 배치 전에 조합을 거르는 용도."""
    bad = []
    for g in groups:
        head, cols = g.layout()
        for width, secs in [(CONTENT_W - 2 * GPAD_X, head)] + \
                           [(COLW, c) for c in cols]:
            limit = width - PAD_L - PAD_R
            for sec in secs:
                # 제목은 굵은체라 폭이 더 넓다. 배지 예약까지 감안해 잴다.
                tw = text_width(sec.title, sans, S_TITLE, "bold")
                if tw > limit - (0.55 * S_TINY / 72 * 6 if sec.badge else 0):
                    bad.append((tw - limit, sec.title))
                for r in sec.rows:
                    if r[0] in ("code", "line"):
                        w = text_width(r[1], FONT_MONO, S_CODE)
                    elif r[0] == "desc":
                        w = text_width(r[1], sans, r[3] or S_DESC)
                    else:
                        continue
                    if w > limit:
                        bad.append((w - limit, r[1]))
    return bad


def _balance(heights, k):
    """순서를 유지한 채 k개 구간으로 나누되, 가장 긴 구간을 최소화한다.

    탐욕적으로 누적합이 목표를 넘을 때 넘기면 마지막 섹션 하나 차이로
    한 단이 통째로 길어진다. 개수가 작으니 전탐색으로 정확히 가른다.
    반환값은 컷 지점 목록(k-1 개).
    """
    n = len(heights)
    if k <= 1 or n <= 1:
        return []
    # 섹션이 단 수보다 적으면 전탐색 범위가 비어 한 단에 몰린다.
    # 그럴 땐 한 단에 하나씩 넣는 게 맞다.
    if n <= k:
        return list(range(1, n))

    best = {"score": None, "cuts": None}

    def walk(start, remaining, cuts):
        if remaining == 1:
            parts = []
            prev = 0
            for c in cuts:
                parts.append(sum(heights[prev:c]))
                prev = c
            parts.append(sum(heights[prev:]))
            score = max(parts)
            if best["score"] is None or score < best["score"] - 1e-9:
                best["score"] = score
                best["cuts"] = list(cuts)
            return
        for c in range(start + 1, n - remaining + 2):
            walk(c, remaining - 1, cuts + [c])

    walk(0, k, [])
    return best["cuts"] or []


class Group:
    def __init__(self, title, sections, full_width_first=False):
        self.title = title
        self.sections = sections
        self.full_width_first = full_width_first

    def layout(self):
        """섹션을 단으로 나눈다. 읽기 순서(위→아래, 좌→우)를 유지한다."""
        head = []
        rest = list(self.sections)
        if self.full_width_first and rest:
            head = [rest.pop(0)]

        heights = [s.height(COLW) for s in rest]
        cuts = _balance(heights, GCOLS)
        cols, prev = [], 0
        for c in cuts + [len(rest)]:
            cols.append(rest[prev:c])
            prev = c
        while len(cols) < GCOLS:
            cols.append([])
        return head, cols

    def height(self):
        head, cols = self.layout()
        head_h = sum(s.height(CONTENT_W - 2 * GPAD_X) for s in head)
        body_h = max((sum(s.height(COLW) for s in c) for c in cols), default=0.0)
        return GPAD_TOP + head_h + body_h + GPAD_BOT


def measure(groups, header_h):
    return header_h + sum(g.height() + GGAP for g in groups) - GGAP + 2 * MARGIN


class Page:
    def __init__(self, sans=FONT_SANS):
        self.sans = sans
        self.groups = []

    def add(self, group):
        self.groups.append(group)

    # ── 렌더 ──
    def render(self, out, header_fn=None, footer=None, force_height=None):
        header_h = header_fn(None, measure=True) if header_fn else 0.0
        total = header_h + sum(g.height() + GGAP for g in self.groups) - GGAP
        height = total + 2 * MARGIN
        if force_height:
            if height > force_height + 1e-6:
                raise ValueError(
                    f"\ub0b4\uc6a9\uc774 \uc9c0\uba74\uc744 \ub118\ub294\ub2e4: {height:.2f}in > {force_height:.2f}in")
            height = force_height

        self.fig = plt.figure(figsize=(W, height), dpi=DPI)
        self.ax = self.fig.add_axes([0, 0, 1, 1])
        self.ax.set_xlim(0, W)
        self.ax.set_ylim(0, height)
        self.ax.axis("off")
        self.fig.patch.set_facecolor("white")
        self.page_h = height
        self.checks = []

        y = height - MARGIN
        if header_fn:
            y = header_fn(self, y=y)
        for g in self.groups:
            y = self._group(g, y) - GGAP
        if footer:
            self.ax.text(W - MARGIN, MARGIN * 0.45, footer, fontsize=5.0 * _S,
                         color=GREY, fontfamily=self.sans, fontweight="bold",
                         ha="right", va="bottom")

        self._report_overflow()
        self.fig.savefig(out, dpi=DPI, facecolor="white", pad_inches=0,
                         metadata=PDF_META if out.endswith(".pdf") else None)
        plt.close(self.fig)
        print(f"saved: {out}   {W:.2f} x {height:.2f} in   "
              f"ratio 1:{height / W:.2f}")
        return height

    def _watch(self, artist, right_limit):
        self.checks.append((artist, right_limit))

    def _report_overflow(self):
        r = self.fig.canvas.get_renderer()
        inv = self.ax.transData.inverted()
        bad = []
        for art, limit in self.checks:
            bb = art.get_window_extent(renderer=r)
            x1 = inv.transform((bb.x1, bb.y0))[0]
            if x1 > limit + 0.005:
                bad.append((x1 - limit, art.get_text()))
        if bad:
            bad.sort(reverse=True)
            print(f"  !! 우측 넘침 {len(bad)}건 (초과 인치, 문자열)")
            for over, txt in bad[:14]:
                print(f"     {over:5.2f}  {txt[:52]}")
        else:
            print("  넘침 없음")

    # ── 여러 장으로 나눠 그리기 (A4 인쇄판) ──
    def _fig(self, groups, height, header_fn, footer, label=None):
        fig = plt.figure(figsize=(W, height), dpi=DPI)
        ax = fig.add_axes([0, 0, 1, 1])
        ax.set_xlim(0, W)
        ax.set_ylim(0, height)
        ax.axis("off")
        fig.patch.set_facecolor("white")
        self.fig, self.ax = fig, ax
        self.page_h = height
        self.checks = []

        y = height - MARGIN
        if header_fn:
            y = header_fn(self, y=y)
        for g in groups:
            y = self._group(g, y) - GGAP
        if footer:
            ax.text(W - MARGIN, MARGIN * 0.45, footer, fontsize=5.0 * _S,
                    color=GREY, fontfamily=self.sans, fontweight="bold",
                    ha="right", va="bottom")
        if label:
            ax.text(MARGIN, MARGIN * 0.45, label, fontsize=5.0 * _S,
                    color=GREY, fontfamily=self.sans, fontweight="bold",
                    ha="left", va="bottom")
        self._report_overflow()
        return fig

    def render_pages(self, pages, out, height, header_fn=None, footer=None):
        """pages: [[group, ...], ...]. 첫 장에만 머리말을 넣는다."""
        from matplotlib.backends.backend_pdf import PdfPages
        n = len(pages)
        if out.endswith(".pdf"):
            with PdfPages(out, metadata=PDF_META) as pdf:
                for i, gs in enumerate(pages):
                    fig = self._fig(gs, height, header_fn if i == 0 else None,
                                    footer, f"{i + 1} / {n}")
                    pdf.savefig(fig, dpi=DPI, facecolor="white")
                    plt.close(fig)
        else:
            base = out[:-4]
            for i, gs in enumerate(pages):
                fig = self._fig(gs, height, header_fn if i == 0 else None,
                                footer, f"{i + 1} / {n}")
                fig.savefig(f"{base}_p{i + 1}.png", dpi=DPI,
                            facecolor="white", pad_inches=0)
                plt.close(fig)
        print(f"saved: {out}   {W:.2f} x {height:.2f} in   {n}장")

    def _group(self, g, top):
        h = g.height()
        box = FancyBboxPatch(
            (MARGIN, top - h), CONTENT_W, h,
            boxstyle=f"round,pad=0,rounding_size={0.07 * _S}",
            linewidth=0.9, edgecolor=GROUPEDGE, facecolor=GROUPBG, zorder=0)
        self.ax.add_patch(box)
        self.ax.text(MARGIN + GPAD_X, top - 0.075 * _S, g.title, fontsize=S_GROUP,
                     color=ORANGE, fontfamily=self.sans, fontweight="bold",
                     ha="left", va="top", zorder=2)
        self.ax.plot([MARGIN + GPAD_X, MARGIN + CONTENT_W - GPAD_X],
                     [top - GPAD_TOP + 0.09 * _S] * 2,
                     color=CORAL, linewidth=1.0 * _S, zorder=2)

        head, cols = g.layout()
        y = top - GPAD_TOP
        for s in head:
            y = self._section(s, MARGIN + GPAD_X, y, CONTENT_W - 2 * GPAD_X)
        base = y
        for i, colsecs in enumerate(cols):
            x = MARGIN + GPAD_X + i * (COLW + COLGAP)
            yy = base
            for s in colsecs:
                yy = self._section(s, x, yy, COLW)
        return top - h

    def _section(self, s, x, y, width):
        bar = FancyBboxPatch(
            (x, y - BAR_H), width, BAR_H,
            boxstyle=f"round,pad=0,rounding_size={0.033 * _S}",
            linewidth=0, facecolor=LIGHT, zorder=1)
        self.ax.add_patch(bar)
        self.ax.text(x + PAD_L, y - 0.038 * SCALE, s.title, fontsize=S_TITLE,
                     color=INK, fontfamily=self.sans, fontweight="bold",
                     ha="left", va="top", zorder=2)
        if s.badge:
            self.ax.text(x + width - PAD_L, y - 0.038 * SCALE, s.badge, fontsize=S_TINY,
                         color="white", fontfamily=self.sans, fontweight="bold",
                         ha="right", va="top", zorder=2,
                         bbox=dict(boxstyle="round,pad=0.22", facecolor=AMBER,
                                   edgecolor="none"))
        y -= LH_HEAD

        for r in s.rows:
            y = self._row(r, x, y, width)
        return y - 0.10 * SCALE

    def _row(self, r, x, y, width):
        k = r[0]
        if k == "code":
            _, left, right, color, indent = r
            a = self.ax.text(x + PAD_L + indent, y, left, fontsize=S_CODE,
                             color=color, fontfamily=FONT_MONO, ha="left",
                             va="top", zorder=2)
            self._watch(a, x + width - PAD_R)
            if right:
                self.ax.text(x + width - PAD_R, y, right, fontsize=S_DESC,
                             color=GREY, fontfamily=self.sans, ha="right",
                             va="top", zorder=2)
            return y - LH_CODE
        if k == "line":
            _, text, color, indent = r
            a = self.ax.text(x + PAD_L + indent, y, text, fontsize=S_CODE,
                             color=color, fontfamily=FONT_MONO, ha="left",
                             va="top", zorder=2)
            self._watch(a, x + width - PAD_R)
            return y - LH_CODE
        if k == "desc":
            _, text, color, size = r
            a = self.ax.text(x + PAD_L, y, text, fontsize=size or S_DESC, color=color,
                             fontfamily=self.sans, ha="left", va="top", zorder=2)
            self._watch(a, x + width - PAD_R)
            return y - LH_DESC
        if k == "kv":
            _, kk, vv, split, vcolor = r
            self.ax.text(x + PAD_L, y, kk, fontsize=S_DESC, color=INK,
                         fontfamily=self.sans, ha="left", va="top", zorder=2)
            self.ax.text(x + PAD_L + width * split, y, vv, fontsize=S_CODE,
                         color=vcolor, fontfamily=FONT_MONO, ha="left",
                         va="top", zorder=2)
            return y - LH_DESC
        if k == "gap":
            return y - r[1]
        if k == "rule":
            yy = y - RULE_PAD
            self.ax.plot([x + PAD_L, x + width - PAD_R], [yy, yy],
                         color=HAIR, linewidth=0.5, zorder=2)
            return yy - RULE_PAD
        if k == "img":
            _, path, max_h = r
            p = Path(path)
            if not p.exists():
                return y
            im = mpimg.imread(str(p))
            ih, iw = im.shape[0], im.shape[1]
            w = width - 0.10
            h = w * ih / iw
            if h > max_h:
                h, w = max_h, max_h * iw / ih
            xx = x + (width - w) / 2
            self.ax.imshow(im, extent=(xx, xx + w, y - h, y), zorder=3,
                           interpolation="lanczos", aspect="auto")
            return y - h - 0.06 * SCALE
        return y
