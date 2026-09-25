"""The bench's flat doc model must agree with prosemirror-py.

Generates a few hundred random steps of every kind the benchmarker
emits, applies each with the real ``Step.apply`` against the real paper
schema, and checks the flat model's paragraphs match the materialized
doc after every step. If this drifts, the bench would 422 in prod-shaped
runs instead of measuring anything.
"""

import random
import sys
from pathlib import Path

import pytest
from prosemirror.transform import Step

from datasette_paper.markdown_parser import markdown_to_doc
from datasette_paper.pm_schema import schema

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bench.docmodel import FlatDoc, seed_markdown  # noqa: E402

GENERATORS = (
    lambda d, r: d.gen_typing(r, r.randint(1, 8)),
    lambda d, r: d.gen_delete(r),
    lambda d, r: d.gen_paste(r, r.randint(50, 400)),
    lambda d, r: d.gen_new_paragraph(r, 30),
    lambda d, r: d.gen_delete_paragraph(r),
    lambda d, r: d.gen_mark(r),
)


def _paras_from_node(node) -> list[str]:
    return [p.text_content for p in node.content.content]


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_generated_steps_apply_and_model_tracks(seed):
    rng = random.Random(seed)
    doc_json = markdown_to_doc(seed_markdown(2000, rng))
    node = schema.node_from_json(doc_json)
    flat = FlatDoc.from_json(doc_json)
    assert flat.paragraphs == _paras_from_node(node)

    for _ in range(300):
        gen = rng.choice(GENERATORS)
        steps = gen(flat, rng)
        for step_json in steps:
            step = Step.from_json(schema, step_json)
            result = step.apply(node)
            assert not result.failed, (step_json, result.failed)
            node = result.doc
            node.check()
            flat.apply(step_json)
            assert flat.paragraphs == _paras_from_node(node), step_json
            assert flat.size == node.content.size


def test_bootstrap_roundtrip():
    doc_json = markdown_to_doc("hello\n\nworld **bold**\n")
    flat = FlatDoc.from_json(doc_json)
    assert flat.paragraphs == ["hello", "world bold"]
    assert flat.size == 7 + 12
