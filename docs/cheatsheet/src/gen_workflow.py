"""치트시트에 넣을 GJC 워크플로 다이어그램을 PaperBanana 로 생성한다."""
import logging
import os
import sys

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# PaperBanana 래퍼(lib.paperbanana)가 있는 파이프라인 경로.
# 로컬 도구라 사람마다 다르다. 환경변수로 지정한다.
PIPELINE = os.environ.get("PAPERBANANA_PIPELINE", "")
if not PIPELINE:
    raise SystemExit("PAPERBANANA_PIPELINE 환경변수에 paper-curation/pipeline 경로를 지정하세요")
sys.path.insert(0, PIPELINE)
from lib.paperbanana import generate_diagram  # noqa: E402

from pathlib import Path as _Path

# src/ 와 assets/ 는 형제 디렉토리. 클론한 곳이 어디든 동작한다.
_ASSETS = _Path(__file__).resolve().parent.parent / "assets"


METHOD = """
# Gajae-Code: plan-gated agent workflow

A coding agent pipeline where every mutation is gated behind an approved plan.
The flow moves strictly left to right through three numbered stages with an
unnumbered approval gate between stage 2 and stage 3. The gate is a decision
point, not a stage — do not give it a number, and do not skip a number because
of it.

## Stage 1 — deep-interview (requirements)
A vague user request enters here. This stage only asks questions and writes a
requirements spec. It is forbidden from touching product source code.
Output: a concrete requirements specification.

## Stage 2 — ralplan (plan + critique)
Consumes the specification and produces an implementation plan, then runs an
adversarial critique pass against that plan. Still read-only.
Output: a reconciled plan receipt.

## APPROVAL GATE (unnumbered)
A distinct diamond-shaped decision gate drawn between stage 2 and stage 3.
It carries no stage number. Nothing downstream may write files until this gate
passes. Label it "approval gate: no mutation before this point". This is the
visual centerpiece.

## Stage 3 — ultragoal (execution + evidence)
Only after the gate: tracks goals through execution, revision, verification,
and evidence collection. This is the only stage allowed to mutate the repo.

## Side branch — autoresearch
An optional research mission that hangs below the main line and feeds evidence
back into ralplan. Drawn as a dashed feedback arrow returning upward into
stage 2, clearly secondary to the main horizontal flow.

## Role agents
Four bundled role agents sit under the execution stage as a small labelled
cluster: executor (writes code), architect (read-only review), planner
(sequencing), critic (plan critique). Show that architect, planner and critic
are read-only lanes and only executor mutates.
"""

CAPTION = (
    "Gajae-Code plan-gated workflow: a strict left-to-right pipeline from "
    "deep-interview to ralplan, through a prominent diamond approval gate, into "
    "ultragoal execution. A dashed autoresearch feedback branch returns evidence "
    "into the planning stage. Flat modern technical diagram, clean horizontal "
    "flow, warm orange and red accent palette on white background, dark charcoal "
    "text, rounded rectangular stage boxes, no photographic elements, no clutter, "
    "generous whitespace, publication quality."
)

if __name__ == "__main__":
    out = str(_ASSETS / "pb_workflow.png")
    data = generate_diagram(
        method=METHOD,
        caption=CAPTION,
        aspect_ratio="16:9",
        critic_rounds=2,
        exp_mode="demo_full",
        retrieval_setting="auto",
        output_path=out,
    )
    print("RESULT_BYTES:", len(data) if data else None)
    print("RESULT_PATH:", out)
