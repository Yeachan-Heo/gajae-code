from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any, TypedDict, cast

JSONValue = str | int | float | bool | None | list["JSONValue"] | dict[str, "JSONValue"]


class WorkflowGateRow(TypedDict, total=False):
    id: str
    stage: str
    kind: str
    schema: dict[str, JSONValue]


@dataclass(frozen=True)
class ActionNeeded:
    id: str
    kind: str
    session_id: str
    question: str | None = None
    options: list[str] | None = None
    workflow_gate_id: str | None = None


@dataclass(frozen=True)
class ActionResolved:
    id: str
    session_id: str | None = None
    resolved_by: str | None = None


@dataclass(frozen=True)
class ReplyRejected:
    id: str
    reason: str


@dataclass(frozen=True)
class Reply:
    id: str
    answer: JSONValue
    token: str = field(repr=False)
    idempotency_key: str | None = None


@dataclass(frozen=True)
class ControlRequest:
    id: str
    operation: str
    input: dict[str, JSONValue]


@dataclass(frozen=True)
class ControlResponse:
    id: str
    ok: bool
    result: JSONValue | None = None
    error: dict[str, JSONValue] | None = None

@dataclass(frozen=True)
class QueryRequest:
    id: str
    query: str
    input: dict[str, JSONValue]
    cursor: str | None = None


@dataclass(frozen=True)
class QueryPage:
    items: list[JSONValue]
    complete: bool
    revision: str
    continuation_cursor: str | None = None
    preview: bool | None = None


@dataclass(frozen=True)
class QueryResponse:
    id: str
    ok: bool
    result: JSONValue | None = None
    page: QueryPage | None = None
    error: dict[str, JSONValue] | None = None


@dataclass(frozen=True)
class GenericFrame:
    raw: dict[str, JSONValue]


Frame = ActionNeeded | ActionResolved | ReplyRejected | Reply | ControlRequest | ControlResponse | QueryRequest | QueryResponse | GenericFrame


def _string(value: dict[str, JSONValue], name: str) -> str | None:
    candidate = value.get(name)
    return candidate if isinstance(candidate, str) else None


def parse_frame(text: str) -> Frame:
    value: Any = json.loads(text)
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError("frame must be a JSON object")
    raw: dict[str, JSONValue] = value
    frame_type = _string(raw, "type")
    identifier = _string(raw, "id")
    if frame_type == "action_needed" and identifier is not None and (session_id := _string(raw, "sessionId")) is not None:
        options = raw.get("options")
        parsed_options = options if isinstance(options, list) and all(isinstance(item, str) for item in options) else None
        return ActionNeeded(identifier, _string(raw, "kind") or "", session_id, _string(raw, "question"), cast(list[str] | None, parsed_options), _string(raw, "workflowGateId"))
    if frame_type == "action_resolved" and identifier is not None:
        return ActionResolved(identifier, _string(raw, "sessionId"), _string(raw, "resolvedBy"))
    if frame_type == "reply_rejected" and identifier is not None and (reason := _string(raw, "reason")) is not None:
        return ReplyRejected(identifier, reason)
    if frame_type == "reply" and identifier is not None and "answer" in raw and (token := _string(raw, "token")) is not None:
        return Reply(identifier, raw["answer"], token, _string(raw, "idempotencyKey"))
    if frame_type == "control_request" and identifier is not None and (operation := _string(raw, "operation")) is not None:
        input_value = raw.get("input")
        if isinstance(input_value, dict):
            return ControlRequest(identifier, operation, input_value)
    if frame_type == "control_response" and identifier is not None:
        ok = raw.get("ok")
        if isinstance(ok, bool):
            result = raw.get("result")
            error = raw.get("error")
            return ControlResponse(identifier, ok, result, cast(dict[str, JSONValue] | None, error) if isinstance(error, dict) else None)
    if frame_type == "query_request" and identifier is not None and (query := _string(raw, "query")) is not None:
        input_value = raw.get("input")
        if isinstance(input_value, dict):
            return QueryRequest(identifier, query, input_value, _string(raw, "cursor"))
    if frame_type == "query_response" and identifier is not None:
        ok = raw.get("ok")
        if isinstance(ok, bool):
            result = raw.get("result")
            error = raw.get("error")
            page_value = raw.get("page")
            page = None
            if isinstance(page_value, dict):
                items = page_value.get("items")
                complete = page_value.get("complete")
                revision = page_value.get("revision")
                continuation_cursor = page_value.get("continuationCursor")
                preview = page_value.get("preview")
                if (
                    isinstance(items, list)
                    and isinstance(complete, bool)
                    and isinstance(revision, str)
                    and (continuation_cursor is None or isinstance(continuation_cursor, str))
                    and (preview is None or isinstance(preview, bool))
                ):
                    page = QueryPage(items, complete, revision, continuation_cursor, preview)
            return QueryResponse(
                identifier,
                ok,
                result,
                page,
                cast(dict[str, JSONValue] | None, error) if isinstance(error, dict) else None,
            )
    return GenericFrame(raw)


def _wire_key(key: str) -> str:
    return {
        "session_id": "sessionId",
        "workflow_gate_id": "workflowGateId",
        "idempotency_key": "idempotencyKey",
        "resolved_by": "resolvedBy",
        "continuation_cursor": "continuationCursor",
    }.get(key, key)


def serialize_frame(frame: Frame) -> str:
    if isinstance(frame, GenericFrame):
        value: dict[str, JSONValue] = frame.raw
    else:
        value = asdict(frame)
        if isinstance(frame, QueryResponse) and frame.page is not None:
            page = cast(dict[str, JSONValue], value["page"])
            value["page"] = {_wire_key(key): item for key, item in page.items() if item is not None}
        value["type"] = {ActionNeeded: "action_needed", ActionResolved: "action_resolved", ReplyRejected: "reply_rejected", Reply: "reply", ControlRequest: "control_request", ControlResponse: "control_response", QueryRequest: "query_request", QueryResponse: "query_response"}[type(frame)]
        value = {_wire_key(key): item for key, item in value.items() if item is not None}
    return json.dumps(value, separators=(",", ":"))


def reply_frame(action_id: str, answer: JSONValue, token: str) -> Reply:
    return Reply(action_id, answer, token)


def control_request_frame(identifier: str, operation: str, input: dict[str, JSONValue]) -> ControlRequest:
    return ControlRequest(identifier, operation, input)


def query_request_frame(identifier: str, query: str, input: dict[str, JSONValue], cursor: str | None = None) -> QueryRequest:
    return QueryRequest(identifier, query, input, cursor)
