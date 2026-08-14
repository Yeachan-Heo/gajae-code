from __future__ import annotations

import asyncio
from collections import deque
from pathlib import Path
from typing import Sequence
from uuid import uuid4

from .discovery import Endpoint, list_session_endpoints, select_live_endpoint
from .frames import (
    ControlRequest,
    ControlResponse,
    Frame,
    JSONValue,
    QueryRequest,
    QueryResponse,
    control_request_frame,
    parse_frame,
    query_request_frame,
    reply_frame,
    serialize_frame,
)
from .transport import SocketTransport, StdioTransport, Transport, WsTransport


_CLIENT_HELLO = '{"type":"hello","protocolVersion":3,"capabilities":["ask_controls_v1"]}'



class SdkClient:
    def __init__(self, transport: Transport, token: str) -> None:
        self._transport = transport
        self._token: str | None = token
        self._receive_lock = asyncio.Lock()
        self._events: deque[Frame] = deque()
        self._responses: dict[str, ControlResponse | QueryResponse] = {}

    def __repr__(self) -> str:
        return f"SdkClient(transport={type(self._transport).__name__}, token=***)"

    @staticmethod
    def _endpoint(repo: str | Path, session_id: str | None) -> Endpoint:
        return select_live_endpoint(list_session_endpoints(repo), session_id)

    @classmethod
    async def connect_ws(cls, repo: str | Path, session_id: str | None = None, *, token: str | None = None, url: str | None = None) -> "SdkClient":
        endpoint = cls._endpoint(repo, session_id) if token is None or url is None else None
        resolved_token = token if token is not None else endpoint.token if endpoint is not None else None
        resolved_url = url if url is not None else endpoint.url if endpoint is not None else None
        if not resolved_token or not resolved_url:
            raise ValueError("SDK endpoint credentials unavailable")
        transport = await WsTransport.connect(resolved_url, resolved_token)
        await transport.send_text(_CLIENT_HELLO)
        return cls(transport, resolved_token)

    @classmethod
    async def connect_socket(cls, socket_path: str, *, repo: str | Path | None = None, session_id: str | None = None, token: str | None = None) -> "SdkClient":
        if token is None:
            if repo is None:
                raise ValueError("repository is required when token is omitted")
            token = cls._endpoint(repo, session_id).token
        if not token:
            raise ValueError("SDK endpoint credentials unavailable")
        transport = await SocketTransport.connect(socket_path, token)
        await transport.send_text(_CLIENT_HELLO)
        return cls(transport, token)

    @classmethod
    async def connect_stdio(cls, *, repo: str | Path, session_id: str, argv: Sequence[str] | None = None, token: str | None = None) -> "SdkClient":
        if token is None:
            token = cls._endpoint(repo, session_id).token
        if not token:
            raise ValueError("SDK endpoint credentials unavailable")
        transport = await StdioTransport.connect(session_id, argv)
        await transport.send_text(_CLIENT_HELLO)
        return cls(transport, token)

    async def recv(self) -> Frame:
        while True:
            if self._events:
                return self._events.popleft()
            async with self._receive_lock:
                if self._events:
                    return self._events.popleft()
                frame = await self._receive_frame()
                if isinstance(frame, (ControlResponse, QueryResponse)):
                    self._responses[frame.id] = frame
                else:
                    return frame

    async def _receive_frame(self) -> Frame:
        return parse_frame(await self._transport.receive_text())

    async def _wait_for_response(self, identifier: str, response_type: type[ControlResponse] | type[QueryResponse]) -> ControlResponse | QueryResponse:
        response = self._responses.pop(identifier, None)
        if response is not None:
            if not isinstance(response, response_type):
                raise ValueError(f"unexpected response type for request {identifier}")
            return response
        async with self._receive_lock:
            response = self._responses.pop(identifier, None)
            if response is not None:
                if not isinstance(response, response_type):
                    raise ValueError(f"unexpected response type for request {identifier}")
                return response
            while True:
                frame = await self._receive_frame()
                if isinstance(frame, (ControlResponse, QueryResponse)):
                    if frame.id == identifier:
                        if not isinstance(frame, response_type):
                            raise ValueError(f"unexpected response type for request {identifier}")
                        return frame
                    self._responses[frame.id] = frame
                else:
                    self._events.append(frame)

    def _require_token(self) -> str:
        if self._token is None:
            raise RuntimeError("client is closed")
        return self._token

    async def send_reply(self, action_id: str, answer: JSONValue) -> None:
        await self._transport.send_text(serialize_frame(reply_frame(action_id, answer, self._require_token())))

    async def control(self, operation: str, input: dict[str, JSONValue], *, id: str | None = None) -> ControlResponse:
        request: ControlRequest = control_request_frame(id or str(uuid4()), operation, input)
        await self._transport.send_text(serialize_frame(request))
        response = await self._wait_for_response(request.id, ControlResponse)
        assert isinstance(response, ControlResponse)
        return response

    async def query(self, query: str, input: dict[str, JSONValue], *, cursor: str | None = None, id: str | None = None) -> QueryResponse:
        request: QueryRequest = query_request_frame(id or str(uuid4()), query, input, cursor)
        await self._transport.send_text(serialize_frame(request))
        response = await self._wait_for_response(request.id, QueryResponse)
        assert isinstance(response, QueryResponse)
        return response

    async def answer_gate(self, gate_id: str, response: JSONValue, *, expected_session_id: str | None = None) -> ControlResponse:
        input: dict[str, JSONValue] = {"id": gate_id, "response": response}
        if expected_session_id is not None:
            input["expectedSessionId"] = expected_session_id
        return await self.control("workflow.gate_answer", input)

    async def close(self) -> None:
        try:
            await self._transport.close()
        finally:
            self._token = None
