import json

from gjc_sdk.frames import ActionNeeded, ActionResolved, ControlRequest, GenericFrame, QueryPage, QueryResponse, Reply, parse_frame, reply_frame, serialize_frame


def test_reply_serialization_includes_token() -> None:
    raw = json.loads(serialize_frame(reply_frame("action-1", {"choice": "yes"}, "secret")))
    assert raw == {"type": "reply", "id": "action-1", "answer": {"choice": "yes"}, "token": "secret"}


def test_serialization_preserves_nested_user_payload() -> None:
    raw = json.loads(
        serialize_frame(ControlRequest("request-1", "status", {"filter": {"session_id": "s", "include": None}}))
    )
    assert raw["input"] == {"filter": {"session_id": "s", "include": None}}


def test_unknown_frame_is_preserved() -> None:
    frame = parse_frame('{"type":"future_frame","newField":{"value":1}}')
    assert isinstance(frame, GenericFrame)
    assert frame.raw == {"type": "future_frame", "newField": {"value": 1}}


def test_reply_round_trip() -> None:
    original = Reply("action-1", ["yes", True], "secret", "retry-1")
    assert parse_frame(serialize_frame(original)) == original


def test_action_needed_round_trip() -> None:
    original = ActionNeeded("action-1", "ask", "session-1", "Proceed?", ["Yes", "No"], "gate-1")
    assert parse_frame(serialize_frame(original)) == original


def test_reply_repr_hides_token() -> None:
    assert "secret-token" not in repr(Reply("action-1", "yes", "secret-token"))


def test_action_resolved_without_session_id_is_typed() -> None:
    frame = parse_frame('{"type":"action_resolved","id":"a1","resolvedBy":"local"}')
    assert frame == ActionResolved("a1", resolved_by="local")


def test_query_page_round_trip() -> None:
    original = QueryResponse("q1", True, page=QueryPage([{"id": "one"}], False, "r1", "next", True))
    assert parse_frame(serialize_frame(original)) == original
