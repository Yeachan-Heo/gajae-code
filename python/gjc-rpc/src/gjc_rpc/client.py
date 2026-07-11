from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Generic, Mapping, Sequence, TypeVar, cast

from .host_tools import HostTool, HostToolContext
from .host_uris import HostUri, HostUriContext, normalize_read_result
from .registry import SessionHandle, list_sessions as _list_sessions
from .protocol import (
    AgentStartEvent,
    AgentEndEvent,
    AgentMessage,
    AssistantMessage,
    AutoCompactionEndEvent,
    AutoCompactionStartEvent,
    AutoRetryEndEvent,
    AutoRetryStartEvent,
    BashResult,
    BranchMessage,
    BranchResult,
    CancellationResult,
    CompactionResult,
    ExtensionError,
    ExtensionUiRequest,
    ImageContent,
    InterruptMode,
    JsonObject,
    JsonValue,
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
    ModelCycleResult,
    ModelInfo,
    ReadyEvent,
    RetryFallbackAppliedEvent,
    RetryFallbackSucceededEvent,
    RpcAgentEvent,
    RpcNotification,
    SessionState,
    SessionStats,
    SteeringMode,
    StreamingBehavior,
    ThinkingLevel,
    ThinkingLevelCycleResult,
    TodoItem,
    TodoPhase,
    TodoStatus,
    TodoAutoClearEvent,
    TodoReminderEvent,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
    ToolExecutionUpdateEvent,
    TtsrTriggeredEvent,
    TurnEndEvent,
    TurnStartEvent,
    UnknownNotification,
    WorkflowGate,
    HandoffResult,
    LoginProvider,
    UnattendedAccepted,
    UnattendedBudget,
    assistant_text,
    parse_agent_messages,
    parse_bash_result,
    parse_branch_messages,
    parse_branch_result,
    parse_cancellation_result,
    parse_compaction_result,
    parse_login_provider,
    parse_unattended_accepted,
    parse_model_cycle_result,
    parse_model_info,
    parse_notification,
    parse_workflow_gate,
    parse_session_state,
    parse_session_stats,
    parse_thinking_level_cycle_result,
    parse_todo_phases,
)

AgentEventListener = Callable[[RpcAgentEvent], None]
NotificationListener = Callable[[RpcNotification], None]
UiRequestListener = Callable[[ExtensionUiRequest], None]
def _effective_event_type(payload: JsonObject) -> object:
    if payload.get("type") == "event":
        frame_payload = payload.get("payload")
        if isinstance(frame_payload, dict):
            inner_event = frame_payload.get("event")
            if isinstance(inner_event, dict):
                return inner_event.get("type")
    return payload.get("type")


WorkflowGateListener = Callable[[WorkflowGate], None]
ExtensionErrorListener = Callable[[ExtensionError], None]
ReadyListener = Callable[[ReadyEvent], None]
UnknownNotificationListener = Callable[[UnknownNotification], None]
AgentStartListener = Callable[[AgentStartEvent], None]
AgentEndListener = Callable[[AgentEndEvent], None]
TurnStartListener = Callable[[TurnStartEvent], None]
TurnEndListener = Callable[[TurnEndEvent], None]
MessageStartListener = Callable[[MessageStartEvent], None]
MessageUpdateListener = Callable[[MessageUpdateEvent], None]
MessageEndListener = Callable[[MessageEndEvent], None]
ToolExecutionStartListener = Callable[[ToolExecutionStartEvent], None]
ToolExecutionUpdateListener = Callable[[ToolExecutionUpdateEvent], None]
ToolExecutionEndListener = Callable[[ToolExecutionEndEvent], None]
AutoCompactionStartListener = Callable[[AutoCompactionStartEvent], None]
AutoCompactionEndListener = Callable[[AutoCompactionEndEvent], None]
AutoRetryStartListener = Callable[[AutoRetryStartEvent], None]
AutoRetryEndListener = Callable[[AutoRetryEndEvent], None]
RetryFallbackAppliedListener = Callable[[RetryFallbackAppliedEvent], None]
RetryFallbackSucceededListener = Callable[[RetryFallbackSucceededEvent], None]
TtsrTriggeredListener = Callable[[TtsrTriggeredEvent], None]
TodoReminderListener = Callable[[TodoReminderEvent], None]
TodoAutoClearListener = Callable[[TodoAutoClearEvent], None]
ProtocolErrorListener = Callable[["RpcProtocolError"], None]
ListenerErrorListener = Callable[["ListenerErrorEvent"], None]
TListener = TypeVar("TListener")
TEventListener = TypeVar("TEventListener", bound=Callable[..., None])
THistoryItem = TypeVar("THistoryItem")

_ASYNC_COMMANDS = frozenset({"prompt", "abort_and_prompt"})
_DEFAULT_ERROR_HISTORY_LIMIT = 128
_TODO_STATUS_VALUES = frozenset({"pending", "in_progress", "completed", "abandoned"})


def _clone_json_value(value: object) -> JsonValue:
    if value is None or isinstance(value, (str, int, float, bool)):
        return cast(JsonValue, value)
    if isinstance(value, list):
        return [_clone_json_value(item) for item in value]
    if isinstance(value, dict):
        cloned: JsonObject = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise RpcError("RPC payload objects must use string keys")
            cloned[key] = _clone_json_value(item)
        return cloned
    raise RpcError("RPC payload must be JSON-serializable")


def _clone_json_object(value: object) -> JsonObject:
    if not isinstance(value, dict):
        raise RpcError("RPC response payload must be an object")
    return cast(JsonObject, _clone_json_value(value))


class RpcError(RuntimeError):
    """Base exception for the Python RPC client."""


class RpcTimeoutError(RpcError):
    """Raised when the server does not respond before a timeout."""


class RpcProcessExitError(RpcError):
    """Raised when the RPC process exits while a request is pending."""


class RpcConcurrencyError(RpcError):
    """Raised when overlapping prompt lifecycle collectors would be ambiguous."""


class RpcCommandError(RpcError):
    """Raised when the RPC server returns `success: false`."""

    def __init__(self, command: str, error: str):
        super().__init__(f"{command}: {error}")
        self.command = command
        self.error = error


class RpcProtocolError(RpcError):
    """Raised or reported when the transport receives an unmatched RPC error response."""

    def __init__(self, payload: JsonObject):
        self.payload = dict(payload)
        command = payload.get("command")
        request_id = payload.get("id")
        error = payload.get("error")
        self.command = str(command) if isinstance(command, str) else None
        self.request_id = str(request_id) if isinstance(request_id, str) else None
        self.remote_error = str(error) if isinstance(error, str) else None

        fragments = ["Received unmatched RPC error response"]
        if self.command:
            fragments.append(f"for {self.command}")
        if self.request_id:
            fragments.append(f"(id={self.request_id})")
        if self.remote_error:
            fragments.append(f": {self.remote_error}")
        super().__init__(" ".join(fragments))


@dataclass(slots=True, frozen=True)
class ListenerErrorEvent:
    listener_kind: str
    source_type: str | None
    listener: Callable[..., None]
    error: BaseException


@dataclass(slots=True, frozen=True)
class PromptTurn:
    events: tuple[RpcAgentEvent, ...]
    messages: tuple[AgentMessage, ...]
    assistant_message: AssistantMessage | None
    assistant_text: str | None

    def require_assistant_text(self) -> str:
        if self.assistant_text is None:
            raise RpcError("Prompt completed without a text assistant message")
        return self.assistant_text


TodoSeed = str | TodoItem | Mapping[str, object]
TodoPhaseSeed = TodoPhase | Mapping[str, object]


@dataclass(slots=True)
class _PendingRequest:
    command: str
    response_queue: queue.Queue[JsonObject | BaseException]


@dataclass(slots=True)
class _PendingHostToolCall:
    cancel_event: threading.Event


@dataclass(slots=True)
class _PendingHostUriRequest:
    cancel_event: threading.Event


@dataclass(slots=True)
class _BoundedHistory(Generic[THistoryItem]):
    limit: int | None
    items: list[THistoryItem] = field(default_factory=list)
    offset: int = 0

    def clear(self) -> None:
        self.items.clear()
        self.offset = 0

    def append(self, item: THistoryItem) -> None:
        self.items.append(item)
        if self.limit is not None and len(self.items) > self.limit:
            trim = len(self.items) - self.limit
            del self.items[:trim]
            self.offset += trim

    def current_index(self) -> int:
        return self.offset + len(self.items)

    def snapshot(self) -> tuple[THistoryItem, ...]:
        return tuple(self.items)

    def snapshot_from(self, start_index: int) -> tuple[THistoryItem, ...]:
        return tuple(self.items[start_index - self.offset :])


@dataclass(slots=True)
class _PromptLifecycleCoordinator:
    lock: threading.Lock = field(default_factory=threading.Lock)
    active_operation: str | None = None

    def acquire(self, operation: str) -> None:
        with self.lock:
            if self.active_operation is not None:
                raise RpcConcurrencyError(
                    f"Cannot start {operation} while {self.active_operation} is already collecting prompt lifecycle events"
                )
            self.active_operation = operation

    def release(self, operation: str) -> None:
        with self.lock:
            if self.active_operation == operation:
                self.active_operation = None


class RpcClient:
    def __init__(
        self,
        *,
        command: Sequence[str] | None = None,
        executable: str = "gjc",
        provider: str | None = None,
        model: str | None = None,
        session_dir: str | Path | None = None,
        cwd: str | Path | None = None,
        env: Mapping[str, str] | None = None,
        user: int | str | None = None,
        group: int | str | None = None,
        extra_groups: Sequence[int | str] | None = None,
        thinking: ThinkingLevel | None = None,
        append_system_prompt: str | None = None,
        provider_session_id: str | None = None,
        tools: Sequence[str] | None = None,
        custom_tools: Sequence[HostTool[Any, Any]] | None = None,
        host_uris: Sequence[HostUri[Any]] | None = None,
        no_session: bool = False,
        no_skills: bool = False,
        no_rules: bool = False,
        no_title: bool | None = None,
        rpc_defaults: bool = True,
        extra_args: Sequence[str] = (),
        startup_timeout: float = 30.0,
        request_timeout: float = 30.0,
        max_event_history: int | None = 10_000,
        max_stderr_chunks: int | None = 512,
    ) -> None:
        self._command = tuple(command) if command is not None else None
        self._executable = executable
        self._provider = provider
        self._model = model
        self._session_dir = Path(session_dir) if session_dir is not None else None
        self._cwd = Path(cwd) if cwd is not None else None
        self._env = dict(env or {})
        self._user = user
        self._group = group
        self._extra_groups = list(extra_groups) if extra_groups is not None else None
        self._thinking = thinking
        self._append_system_prompt = append_system_prompt
        self._provider_session_id = provider_session_id
        self._tools = tuple(tools) if tools is not None else None
        self._custom_tools = tuple(custom_tools) if custom_tools is not None else ()
        self._host_uris = tuple(host_uris) if host_uris is not None else ()
        self._no_session = no_session
        self._no_skills = no_skills
        self._no_rules = no_rules
        self._no_title = no_title
        self._rpc_defaults = rpc_defaults
        self._extra_args = tuple(extra_args)
        self._startup_timeout = startup_timeout
        self._request_timeout = request_timeout
        self._max_event_history = self._validate_history_limit("max_event_history", max_event_history)
        self._max_stderr_chunks = self._validate_history_limit("max_stderr_chunks", max_stderr_chunks)

        self._process: subprocess.Popen[str] | None = None
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._event_condition = threading.Condition()
        self._pending: dict[str, _PendingRequest] = {}
        self._pending_host_tool_calls: dict[str, _PendingHostToolCall] = {}
        self._pending_host_uri_requests: dict[str, _PendingHostUriRequest] = {}
        self._request_id = 0
        self._events = _BoundedHistory[JsonObject](self._max_event_history)
        self._async_errors = _BoundedHistory[BaseException](_DEFAULT_ERROR_HISTORY_LIMIT)
        self._scheduled_agent_runs = 0
        self._completed_agent_runs = 0
        self._last_schedule_async_error_index = 0
        self._ui_requests: queue.Queue[ExtensionUiRequest] = queue.Queue()
        self._workflow_gates: queue.Queue[WorkflowGate] = queue.Queue()
        self._stderr_chunks = _BoundedHistory[str](self._max_stderr_chunks)
        self._closed_error: BaseException | None = None
        self._stopping = False
        self._ready_received = False
        self._protocol_errors = _BoundedHistory[RpcProtocolError](_DEFAULT_ERROR_HISTORY_LIMIT)
        self._listener_errors = _BoundedHistory[ListenerErrorEvent](_DEFAULT_ERROR_HISTORY_LIMIT)
        self._prompt_lifecycle = _PromptLifecycleCoordinator()

        self._notification_listeners: list[NotificationListener] = []
        self._event_listeners: list[AgentEventListener] = []
        self._typed_event_listeners: dict[str, list[AgentEventListener]] = {}
        self._ready_listeners: list[ReadyListener] = []
        self._unknown_notification_listeners: list[UnknownNotificationListener] = []
        self._ui_request_listeners: list[UiRequestListener] = []
        self._workflow_gate_listeners: list[WorkflowGateListener] = []
        self._extension_error_listeners: list[ExtensionErrorListener] = []
        self._protocol_error_listeners: list[ProtocolErrorListener] = []
        self._listener_error_listeners: list[ListenerErrorListener] = []

    def __enter__(self) -> RpcClient:
        return self.start()

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        self.stop()

    @property
    def stderr(self) -> str:
        with self._state_lock:
            return "".join(self._stderr_chunks.snapshot())

    @property
    def command(self) -> tuple[str, ...]:
        return self._build_command()

    @property
    def protocol_errors(self) -> tuple[RpcProtocolError, ...]:
        with self._state_lock:
            return self._protocol_errors.snapshot()

    @property
    def listener_errors(self) -> tuple[ListenerErrorEvent, ...]:
        with self._state_lock:
            return self._listener_errors.snapshot()

    def start(self) -> RpcClient:
        if self._process is not None:
            raise RpcError("RPC client is already started")

        self._ready.clear()
        self._stopping = False
        self._closed_error = None
        self._ready_received = False
        self._events.clear()
        self._async_errors.clear()
        self._scheduled_agent_runs = 0
        self._completed_agent_runs = 0
        self._last_schedule_async_error_index = 0
        self._ui_requests = queue.Queue()
        self._workflow_gates = queue.Queue()
        with self._state_lock:
            self._stderr_chunks.clear()
        with self._state_lock:
            self._protocol_errors.clear()
            self._listener_errors.clear()

        process = subprocess.Popen(
            list(self._build_command()),
            cwd=str(self._cwd) if self._cwd is not None else None,
            env={**os.environ, **self._env},
            user=self._user,
            group=self._group,
            extra_groups=self._extra_groups,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self._process = process

        self._stdout_thread = threading.Thread(target=self._read_stdout_loop, name="gjc-rpc-stdout", daemon=True)
        self._stderr_thread = threading.Thread(target=self._read_stderr_loop, name="gjc-rpc-stderr", daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()

        if not self._ready.wait(self._startup_timeout):
            stderr = self.stderr
            self.stop()
            raise RpcTimeoutError(f"Timed out waiting for RPC ready signal. Stderr: {stderr}")

        if not self._ready_received:
            error = self._closed_error
            stderr = self.stderr
            self.stop()
            if isinstance(error, RpcError):
                raise error
            if error is not None:
                raise RpcProcessExitError(f"RPC process stopped before ready: {error}. Stderr: {stderr}") from error
            raise RpcTimeoutError(f"Timed out waiting for RPC ready signal. Stderr: {stderr}")

        try:
            if self._custom_tools:
                self.set_custom_tools(self._custom_tools)
            if self._host_uris:
                self.set_host_uris(self._host_uris)
        except BaseException:
            self.stop()
            raise
        return self

    def stop(self) -> None:
        process = self._process
        if process is None:
            return

        self._stopping = True
        for pending_call in self._pending_host_tool_calls.values():
            pending_call.cancel_event.set()
        for pending_uri in self._pending_host_uri_requests.values():
            pending_uri.cancel_event.set()

        try:
            if process.stdin is not None:
                try:
                    process.stdin.close()
                except OSError:
                    pass

            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=1.0)
        finally:
            if process.stdout is not None:
                try:
                    process.stdout.close()
                except OSError:
                    pass
            if process.stderr is not None:
                try:
                    process.stderr.close()
                except OSError:
                    pass
            # Mark the client closed so any thread blocked in
            # `_wait_for_agent_end` raises `RpcProcessExitError` instead of
            # waiting for its request timeout. The stdout reader loop would
            # normally do this when it observes the closed pipe, but it
            # guards on `if not self._stopping:` — which is True by the time
            # we get here — and so skips it. Calling `_mark_closed` directly
            # closes the gap. It is idempotent: a second call (e.g. from the
            # reader's exception path) returns early.
            self._mark_closed(RpcProcessExitError("RPC process stopped"))
            self._pending_host_tool_calls.clear()
            self._pending_host_uri_requests.clear()
            self._process = None
            if self._stdout_thread is not None:
                self._stdout_thread.join(timeout=1.0)
            if self._stderr_thread is not None:
                self._stderr_thread.join(timeout=1.0)
            self._stdout_thread = None
            self._stderr_thread = None

    def on_event(self, listener: AgentEventListener) -> Callable[[], None]:
        self._event_listeners.append(listener)
        return lambda: self._remove_listener(self._event_listeners, listener)

    def on_notification(self, listener: NotificationListener) -> Callable[[], None]:
        self._notification_listeners.append(listener)
        return lambda: self._remove_listener(self._notification_listeners, listener)

    def on_ready(self, listener: ReadyListener) -> Callable[[], None]:
        self._ready_listeners.append(listener)
        return lambda: self._remove_listener(self._ready_listeners, listener)

    def on_agent_start(self, listener: AgentStartListener) -> Callable[[], None]:
        return self._add_typed_event_listener("agent_start", listener)

    def on_agent_end(self, listener: AgentEndListener) -> Callable[[], None]:
        return self._add_typed_event_listener("agent_end", listener)

    def on_turn_start(self, listener: TurnStartListener) -> Callable[[], None]:
        return self._add_typed_event_listener("turn_start", listener)

    def on_turn_end(self, listener: TurnEndListener) -> Callable[[], None]:
        return self._add_typed_event_listener("turn_end", listener)

    def on_message_start(self, listener: MessageStartListener) -> Callable[[], None]:
        return self._add_typed_event_listener("message_start", listener)

    def on_message_update(self, listener: MessageUpdateListener) -> Callable[[], None]:
        return self._add_typed_event_listener("message_update", listener)

    def on_message_end(self, listener: MessageEndListener) -> Callable[[], None]:
        return self._add_typed_event_listener("message_end", listener)

    def on_tool_execution_start(self, listener: ToolExecutionStartListener) -> Callable[[], None]:
        return self._add_typed_event_listener("tool_execution_start", listener)

    def on_tool_execution_update(self, listener: ToolExecutionUpdateListener) -> Callable[[], None]:
        return self._add_typed_event_listener("tool_execution_update", listener)

    def on_tool_execution_end(self, listener: ToolExecutionEndListener) -> Callable[[], None]:
        return self._add_typed_event_listener("tool_execution_end", listener)

    def on_auto_compaction_start(self, listener: AutoCompactionStartListener) -> Callable[[], None]:
        return self._add_typed_event_listener("auto_compaction_start", listener)

    def on_auto_compaction_end(self, listener: AutoCompactionEndListener) -> Callable[[], None]:
        return self._add_typed_event_listener("auto_compaction_end", listener)

    def on_auto_retry_start(self, listener: AutoRetryStartListener) -> Callable[[], None]:
        return self._add_typed_event_listener("auto_retry_start", listener)

    def on_auto_retry_end(self, listener: AutoRetryEndListener) -> Callable[[], None]:
        return self._add_typed_event_listener("auto_retry_end", listener)

    def on_retry_fallback_applied(self, listener: RetryFallbackAppliedListener) -> Callable[[], None]:
        return self._add_typed_event_listener("retry_fallback_applied", listener)

    def on_retry_fallback_succeeded(self, listener: RetryFallbackSucceededListener) -> Callable[[], None]:
        return self._add_typed_event_listener("retry_fallback_succeeded", listener)

    def on_ttsr_triggered(self, listener: TtsrTriggeredListener) -> Callable[[], None]:
        return self._add_typed_event_listener("ttsr_triggered", listener)

    def on_todo_reminder(self, listener: TodoReminderListener) -> Callable[[], None]:
        return self._add_typed_event_listener("todo_reminder", listener)

    def on_todo_auto_clear(self, listener: TodoAutoClearListener) -> Callable[[], None]:
        return self._add_typed_event_listener("todo_auto_clear", listener)

    def on_ui_request(self, listener: UiRequestListener) -> Callable[[], None]:
        self._ui_request_listeners.append(listener)
        return lambda: self._remove_listener(self._ui_request_listeners, listener)


    def on_workflow_gate(self, listener: WorkflowGateListener) -> Callable[[], None]:
        """Register a typed listener for inbound `workflow_gate` events (#322)."""
        self._workflow_gate_listeners.append(listener)
        return lambda: self._remove_listener(self._workflow_gate_listeners, listener)

    def respond_gate(self, gate_id: str, answer: object, *, idempotency_key: str | None = None) -> JsonObject:
        """Answer a workflow gate and return the accepted/rejected resolution envelope (#322)."""
        return self._request(
            "workflow_gate_response",
            gate_id=gate_id,
            answer=_clone_json_value(answer),
            idempotency_key=idempotency_key,
        )

    def run_workflow_gate_policy(
        self, resolver: Callable[[WorkflowGate], object]
    ) -> Callable[[], None]:
        """Headless policy: route every received gate to ``resolver`` and respond.

        ``resolver`` returns the answer (the agent's memory-backed decision); it is
        posted via :meth:`respond_gate`. Returns an unsubscribe callable.
        """

        def handle(gate: WorkflowGate) -> None:
            threading.Thread(
                target=lambda: self.respond_gate(gate.gate_id, resolver(gate)),
                name=f"gjc-rpc-workflow-gate-{gate.gate_id}",
                daemon=True,
            ).start()

        return self.on_workflow_gate(handle)
    def on_extension_error(self, listener: ExtensionErrorListener) -> Callable[[], None]:
        self._extension_error_listeners.append(listener)
        return lambda: self._remove_listener(self._extension_error_listeners, listener)

    def on_protocol_error(self, listener: ProtocolErrorListener) -> Callable[[], None]:
        self._protocol_error_listeners.append(listener)
        return lambda: self._remove_listener(self._protocol_error_listeners, listener)

    def on_listener_error(self, listener: ListenerErrorListener) -> Callable[[], None]:
        self._listener_error_listeners.append(listener)
        return lambda: self._remove_listener(self._listener_error_listeners, listener)

    def on_unknown_notification(self, listener: UnknownNotificationListener) -> Callable[[], None]:
        self._unknown_notification_listeners.append(listener)
        return lambda: self._remove_listener(self._unknown_notification_listeners, listener)

    def install_headless_ui(
        self,
        *,
        on_request: UiRequestListener | None = None,
        confirm: bool = False,
        select_value: str | None = None,
        input_value: str | None = None,
        editor_value: str | None = None,
    ) -> Callable[[], None]:
        """Auto-handle RPC UI requests for non-interactive hosts.

        Passive UI methods such as notifications and status updates are ignored.
        Confirm dialogs default to `False`. Select, input, and editor requests
        are cancelled unless an explicit value is provided.
        """

        def handle(request: ExtensionUiRequest) -> None:
            if on_request is not None:
                try:
                    on_request(request)
                except Exception as exc:
                    self._record_listener_error(
                        ListenerErrorEvent(
                            listener_kind="headless_ui_request",
                            source_type=request.type,
                            listener=on_request,
                            error=exc,
                        )
                    )

            if request.method == "cancel" or request.is_passive():
                return
            if request.method == "confirm":
                self.send_ui_confirmation(request.id, confirm)
                return
            if request.method == "select":
                if select_value is not None:
                    self.send_ui_value(request.id, select_value)
                else:
                    self.cancel_ui_request(request.id)
                return
            if request.method == "input":
                if input_value is not None:
                    self.send_ui_value(request.id, input_value)
                else:
                    self.cancel_ui_request(request.id)
                return
            if request.method == "editor":
                if editor_value is not None:
                    self.send_ui_value(request.id, editor_value)
                else:
                    self.cancel_ui_request(request.id)

        return self.on_ui_request(handle)

    def next_workflow_gate(self, timeout: float | None = None) -> WorkflowGate:
        try:
            return self._workflow_gates.get(timeout=timeout)
        except queue.Empty as exc:
            raise RpcTimeoutError("Timed out waiting for a workflow gate") from exc

    def next_ui_request(self, timeout: float | None = None) -> ExtensionUiRequest:
        try:
            return self._ui_requests.get(timeout=timeout)
        except queue.Empty as exc:
            raise RpcTimeoutError("Timed out waiting for an extension UI request") from exc

    def send_ui_value(self, request_id: str, value: str) -> None:
        self._send_notification({"type": "extension_ui_response", "id": request_id, "value": value})

    def send_ui_confirmation(self, request_id: str, confirmed: bool) -> None:
        self._send_notification({"type": "extension_ui_response", "id": request_id, "confirmed": confirmed})

    def send_workflow_gate_response(self, gate_id: str, answer: JsonValue) -> None:
        self._request("workflow_gate_response", gate_id=gate_id, answer=answer)

    def get_pending_workflow_gates(self) -> tuple[WorkflowGate, ...]:
        payload = self._request("get_pending_workflow_gates")
        gates = payload.get("gates")
        if not isinstance(gates, list):
            return ()
        return tuple(parse_workflow_gate(cast(JsonObject, gate)) for gate in gates if isinstance(gate, dict))

    def cancel_ui_request(self, request_id: str, *, timed_out: bool = False) -> None:
        payload: JsonObject = {"type": "extension_ui_response", "id": request_id, "cancelled": True}
        if timed_out:
            payload["timedOut"] = True
        self._send_notification(payload)

    def get_state(self) -> SessionState:
        payload = self._request("get_state")
        return parse_session_state(payload)

    def set_model(self, provider: str, model_id: str) -> ModelInfo:
        payload = self._request("set_model", provider=provider, modelId=model_id)
        model = parse_model_info(payload)
        if model is None:
            raise RpcError("set_model returned an empty payload")
        return model

    def cycle_model(self) -> ModelCycleResult | None:
        return parse_model_cycle_result(self._request("cycle_model"))

    def get_available_models(self) -> tuple[ModelInfo, ...]:
        payload = self._request("get_available_models")
        models = cast(list[JsonObject], payload.get("models") or [])
        return tuple(filter(None, (parse_model_info(model) for model in models)))

    def set_thinking_level(self, level: ThinkingLevel) -> None:
        self._request("set_thinking_level", level=level)

    def cycle_thinking_level(self) -> ThinkingLevelCycleResult | None:
        return parse_thinking_level_cycle_result(self._request("cycle_thinking_level"))

    def set_steering_mode(self, mode: SteeringMode) -> None:
        self._request("set_steering_mode", mode=mode)

    def set_follow_up_mode(self, mode: SteeringMode) -> None:
        self._request("set_follow_up_mode", mode=mode)

    def set_interrupt_mode(self, mode: InterruptMode) -> None:
        self._request("set_interrupt_mode", mode=mode)

    def compact(self, custom_instructions: str | None = None) -> CompactionResult:
        payload = self._request("compact", customInstructions=custom_instructions)
        return parse_compaction_result(payload)

    def set_auto_compaction(self, enabled: bool) -> None:
        self._request("set_auto_compaction", enabled=enabled)

    def set_auto_retry(self, enabled: bool) -> None:
        self._request("set_auto_retry", enabled=enabled)

    def abort_retry(self) -> None:
        self._request("abort_retry")

    def bash(self, command: str) -> BashResult:
        payload = self._request("bash", command=command)
        return parse_bash_result(payload)

    def abort_bash(self) -> None:
        self._request("abort_bash")

    def get_session_stats(self) -> SessionStats:
        payload = self._request("get_session_stats")
        return parse_session_stats(payload)

    def export_html(self, output_path: str | Path | None = None) -> Path:
        payload = self._request("export_html", outputPath=str(output_path) if output_path is not None else None)
        return Path(str(payload["path"]))

    def new_session(self, parent_session: str | None = None) -> CancellationResult:
        return parse_cancellation_result(self._request("new_session", parentSession=parent_session))

    def switch_session(self, session_path: str | Path) -> CancellationResult:
        return parse_cancellation_result(self._request("switch_session", sessionPath=str(session_path)))

    def branch(self, entry_id: str) -> BranchResult:
        return parse_branch_result(self._request("branch", entryId=entry_id))

    def get_branch_messages(self) -> tuple[BranchMessage, ...]:
        return parse_branch_messages(self._request("get_branch_messages"))

    def get_last_assistant_text(self) -> str | None:
        payload = self._request("get_last_assistant_text")
        value = payload.get("text")
        return str(value) if isinstance(value, str) else None

    def set_session_name(self, name: str) -> None:
        self._request("set_session_name", name=name)

    def get_todos(self) -> tuple[TodoPhase, ...]:
        return self.get_state().todo_phases

    def set_todos(self, todos: Sequence[TodoSeed | TodoPhaseSeed]) -> tuple[TodoPhase, ...]:
        phases = self._normalize_todo_phases(todos)
        payload = self._request("set_todos", phases=cast(JsonValue, phases))
        return parse_todo_phases(payload.get("todoPhases"))

    def clear_todos(self) -> tuple[TodoPhase, ...]:
        return self.set_todos(())

    def get_messages(self) -> tuple[AgentMessage, ...]:
        payload = self._request("get_messages")
        return parse_agent_messages(cast(JsonValue | None, payload.get("messages")))

    def negotiate_unattended(
        self,
        *,
        actor: str,
        budget: UnattendedBudget,
        scopes: Sequence[str],
        action_allowlist: Sequence[str],
    ) -> UnattendedAccepted:
        payload = self._request(
            "negotiate_unattended",
            declaration=cast(
                JsonValue,
                {
                    "actor": actor,
                    "budget": {
                        "max_tokens": budget.max_tokens,
                        "max_tool_calls": budget.max_tool_calls,
                        "max_wall_time_ms": budget.max_wall_time_ms,
                        "max_cost_usd": budget.max_cost_usd,
                    },
                    "scopes": list(scopes),
                    "action_allowlist": list(action_allowlist),
                },
            ),
        )
        return parse_unattended_accepted(payload)

    def handoff(self, custom_instructions: str | None = None) -> HandoffResult | None:
        payload = self._request("handoff", customInstructions=custom_instructions)
        if not payload:
            return None
        saved = payload.get("savedPath")
        return HandoffResult(saved_path=saved if isinstance(saved, str) else None)

    def get_login_providers(self) -> tuple[LoginProvider, ...]:
        payload = self._request("get_login_providers")
        providers = payload.get("providers")
        if not isinstance(providers, list):
            return ()
        return tuple(parse_login_provider(cast(JsonObject, item)) for item in providers)

    def login(self, provider_id: str) -> str:
        payload = self._request("login", providerId=provider_id)
        return str(payload.get("providerId", provider_id))

    @staticmethod
    def list_sessions(sessions_dir: str | Path | None = None) -> tuple[SessionHandle, ...]:
        """Discover live gjc RPC sessions from the cross-process registry (issue 10)."""
        return _list_sessions(sessions_dir)

    def set_custom_tools(self, tools: Sequence[HostTool[Any, Any]]) -> tuple[str, ...]:
        self._custom_tools = tuple(tools)
        if self._process is None:
            return tuple(tool.name for tool in self._custom_tools)

        payload = self._request(
            "set_host_tools",
            tools=cast(
                JsonValue,
                [
                    {
                        "name": tool.name,
                        "label": tool.label,
                        "description": tool.description,
                        "parameters": tool.parameters,
                        "hidden": tool.hidden,
                    }
                    for tool in self._custom_tools
                ],
            ),
        )
        tool_names = payload.get("toolNames") or []
        if not isinstance(tool_names, list):
            raise RpcError("set_host_tools response did not include toolNames")
        return tuple(str(name) for name in tool_names)

    def set_host_uris(self, host_uris: Sequence[HostUri[Any]]) -> tuple[str, ...]:
        self._host_uris = tuple(host_uris)
        if self._process is None:
            return tuple(uri.scheme for uri in self._host_uris)

        schemes_payload: list[JsonObject] = []
        for uri in self._host_uris:
            entry: JsonObject = {"scheme": uri.scheme, "writable": uri.writable, "immutable": uri.immutable}
            if uri.description is not None:
                entry["description"] = uri.description
            schemes_payload.append(entry)

        payload = self._request(
            "set_host_uri_schemes",
            schemes=cast(JsonValue, schemes_payload),
        )
        schemes = payload.get("schemes") or []
        if not isinstance(schemes, list):
            raise RpcError("set_host_uri_schemes response did not include schemes")
        return tuple(str(entry) for entry in schemes)

    def prompt(
        self,
        message: str,
        *,
        images: Sequence[ImageContent] | None = None,
        streaming_behavior: StreamingBehavior | None = None,
    ) -> None:
        self._request(
            "prompt",
            message=message,
            images=list(images) if images is not None else None,
            streamingBehavior=streaming_behavior,
        )
        self._mark_agent_run_scheduled()

    def steer(self, message: str, *, images: Sequence[ImageContent] | None = None) -> None:
        self._request("steer", message=message, images=list(images) if images is not None else None)

    def follow_up(self, message: str, *, images: Sequence[ImageContent] | None = None) -> None:
        self._request("follow_up", message=message, images=list(images) if images is not None else None)

    def abort(self) -> None:
        self._request("abort")

    def abort_and_prompt(self, message: str, *, images: Sequence[ImageContent] | None = None) -> None:
        self._request("abort_and_prompt", message=message, images=list(images) if images is not None else None)
        self._mark_agent_run_scheduled()

    def prompt_and_wait(
        self,
        message: str,
        *,
        images: Sequence[ImageContent] | None = None,
        streaming_behavior: StreamingBehavior | None = None,
        timeout: float | None = None,
    ) -> PromptTurn:
        operation = "prompt_and_wait"
        self._prompt_lifecycle.acquire(operation)
        try:
            start_index = self._current_event_index()
            start_async_error_index = self._current_async_error_index()
            self.prompt(message, images=images, streaming_behavior=streaming_behavior)
            events = self._wait_for_agent_end(start_index, start_async_error_index, timeout=timeout)
            return self._build_prompt_turn(events)
        finally:
            self._prompt_lifecycle.release(operation)

    def wait_for_idle(self, timeout: float | None = None) -> None:
        operation = "wait_for_idle"
        self._prompt_lifecycle.acquire(operation)
        try:
            if self._is_agent_idle():
                self._check_async_errors()
                return
            start_index = self._current_event_index()
            start_async_error_index = self._current_async_error_index()
            self._wait_for_agent_end(start_index, start_async_error_index, timeout=timeout)
        finally:
            self._prompt_lifecycle.release(operation)

    def collect_events(self, timeout: float | None = None) -> tuple[RpcAgentEvent, ...]:
        operation = "collect_events"
        self._prompt_lifecycle.acquire(operation)
        try:
            start_index = self._current_event_index()
            start_async_error_index = self._current_async_error_index()
            return self._wait_for_agent_end(start_index, start_async_error_index, timeout=timeout)
        finally:
            self._prompt_lifecycle.release(operation)

    def request_raw(self, command_type: str, **payload: JsonValue) -> JsonObject:
        return self._request(command_type, **payload)

    def _current_event_index(self) -> int:
        with self._event_condition:
            return self._events.current_index()

    def _current_async_error_index(self) -> int:
        with self._event_condition:
            return self._async_errors.current_index()

    def _mark_agent_run_scheduled(self) -> None:
        with self._event_condition:
            self._scheduled_agent_runs += 1
            self._last_schedule_async_error_index = self._async_errors.current_index()
    def _mark_agent_run_completed(self) -> None:
        with self._event_condition:
            self._completed_agent_runs += 1
            self._event_condition.notify_all()

    def _is_agent_idle(self) -> bool:
        with self._event_condition:
            return self._scheduled_agent_runs == self._completed_agent_runs

    def _check_async_errors(self) -> None:
        with self._event_condition:
            errors = self._async_errors.snapshot_from(self._last_schedule_async_error_index)
        if errors:
            raise errors[0]

    def _build_prompt_turn(self, events: tuple[RpcAgentEvent, ...]) -> PromptTurn:
        final_messages: tuple[AgentMessage, ...] = ()
        for event in reversed(events):
            if isinstance(event, AgentEndEvent):
                final_messages = event.messages
                break

        assistant_message: AssistantMessage | None = None
        for message in reversed(final_messages):
            if message.get("role") == "assistant":
                assistant_message = cast(AssistantMessage, message)
                break

        if assistant_message is None:
            for event in reversed(events):
                if hasattr(event, "message"):
                    message = cast(AgentMessage | None, getattr(event, "message", None))
                    if isinstance(message, dict) and message.get("role") == "assistant":
                        assistant_message = cast(AssistantMessage, message)
                        break

        return PromptTurn(
            events=events,
            messages=final_messages,
            assistant_message=assistant_message,
            assistant_text=assistant_text(assistant_message) if assistant_message is not None else None,
        )

    def _wait_for_agent_end(
        self,
        start_index: int,
        start_async_error_index: int,
        timeout: float | None = None,
    ) -> tuple[RpcAgentEvent, ...]:
        deadline = time.monotonic() + (timeout if timeout is not None else 60.0)
        with self._event_condition:
            while True:
                if self._closed_error is not None:
                    raise RpcProcessExitError(str(self._closed_error))

                if start_index < self._events.offset:
                    raise RpcError(
                        "Event history limit was exceeded while waiting for agent_end. "
                        "Increase max_event_history to retain more streamed events."
                    )

                if start_async_error_index < self._async_errors.offset:
                    raise RpcError(
                        "Async error history limit was exceeded while waiting for agent_end. "
                        "Increase max_event_history if your host needs to retain more background failures."
                    )

                async_errors = self._async_errors.snapshot_from(start_async_error_index)
                if len(async_errors) > 0:
                    raise async_errors[0]

                event_payloads = self._events.snapshot_from(start_index)
                if any(_effective_event_type(payload) == "agent_end" for payload in event_payloads):
                    events = tuple(cast(RpcAgentEvent, parse_notification(payload)) for payload in event_payloads)
                    return events

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RpcTimeoutError(f"Timed out waiting for agent_end. Stderr: {self.stderr}")
                self._event_condition.wait(remaining)

    def _request(self, command_type: str, **payload: JsonValue) -> JsonObject:
        process = self._require_process()
        request_id = self._next_request_id()
        envelope: JsonObject = {"id": request_id, "type": command_type}
        for key, value in payload.items():
            if value is not None:
                envelope[key] = value

        response_queue: queue.Queue[JsonObject | BaseException] = queue.Queue(maxsize=1)
        with self._state_lock:
            self._pending[request_id] = _PendingRequest(command=command_type, response_queue=response_queue)

        try:
            self._write_json(process, envelope)
        except BaseException:
            with self._state_lock:
                self._pending.pop(request_id, None)
            raise

        try:
            response = response_queue.get(timeout=self._request_timeout)
        except queue.Empty as exc:
            with self._state_lock:
                self._pending.pop(request_id, None)
            raise RpcTimeoutError(f"Timed out waiting for response to {command_type}. Stderr: {self.stderr}") from exc

        if isinstance(response, BaseException):
            raise response

        if not bool(response.get("success", False)):
            raise RpcCommandError(command=str(response.get("command", command_type)), error=str(response.get("error", "")))

        data = response.get("data")
        if data is None:
            return {}
        return _clone_json_object(data)

    def _send_notification(self, payload: JsonObject) -> None:
        process = self._require_process()
        self._write_json(process, payload)

    def _normalize_host_tool_result(self, result: object) -> JsonObject:
        if isinstance(result, str):
            return {"content": [{"type": "text", "text": result}]}
        if isinstance(result, Mapping):
            return cast(JsonObject, dict(result))
        raise RpcError("Host tool handlers must return a string or a result mapping")

    def _handle_host_tool_call(self, payload: JsonObject) -> None:
        request_id = payload.get("id")
        tool_name = payload.get("toolName")
        tool_call_id = payload.get("toolCallId")
        raw_arguments = payload.get("arguments")
        if not isinstance(request_id, str) or not isinstance(tool_name, str) or not isinstance(tool_call_id, str):
            return
        if not isinstance(raw_arguments, Mapping):
            self._send_notification(
                {
                    "type": "host_tool_result",
                    "id": request_id,
                    "result": {"content": [{"type": "text", "text": "Host tool arguments must be an object"}], "details": {}},
                    "isError": True,
                }
            )
            return

        tool = next((candidate for candidate in self._custom_tools if candidate.name == tool_name), None)
        if tool is None:
            self._send_notification(
                {
                    "type": "host_tool_result",
                    "id": request_id,
                    "result": {
                        "content": [{"type": "text", "text": f'Host tool "{tool_name}" is not registered'}],
                        "details": {},
                    },
                    "isError": True,
                }
            )
            return

        pending_call = _PendingHostToolCall(cancel_event=threading.Event())
        self._pending_host_tool_calls[request_id] = pending_call

        def run_tool() -> None:
            try:
                params = tool.parse_params(cast(JsonObject, dict(raw_arguments)))
                context = HostToolContext(
                    tool_call_id=tool_call_id,
                    _cancel_event=pending_call.cancel_event,
                    _send_update=lambda result: self._send_notification(
                        {"type": "host_tool_update", "id": request_id, "partialResult": result}
                    ),
                )
                result = tool.execute(params, context)
                if pending_call.cancel_event.is_set():
                    return
                self._send_notification(
                    {
                        "type": "host_tool_result",
                        "id": request_id,
                        "result": self._normalize_host_tool_result(result),
                    }
                )
            except Exception as exc:
                if pending_call.cancel_event.is_set():
                    return
                self._send_notification(
                    {
                        "type": "host_tool_result",
                        "id": request_id,
                        "result": {"content": [{"type": "text", "text": str(exc)}], "details": {}},
                        "isError": True,
                    }
                )
            finally:
                self._pending_host_tool_calls.pop(request_id, None)

        threading.Thread(target=run_tool, name=f"gjc-rpc-host-tool:{tool_name}", daemon=True).start()

    def _handle_host_tool_cancel(self, payload: JsonObject) -> None:
        target_id = payload.get("targetId")
        if not isinstance(target_id, str):
            return
        pending_call = self._pending_host_tool_calls.get(target_id)
        if pending_call is not None:
            pending_call.cancel_event.set()

    def _send_host_uri_error(self, request_id: str, message: str) -> None:
        self._send_notification(
            {
                "type": "host_uri_result",
                "id": request_id,
                "error": message,
                "isError": True,
            }
        )

    def _handle_host_uri_request(self, payload: JsonObject) -> None:
        request_id = payload.get("id")
        operation = payload.get("operation")
        url = payload.get("url")
        if not isinstance(request_id, str) or not isinstance(operation, str) or not isinstance(url, str):
            return
        if operation not in ("read", "write"):
            self._send_host_uri_error(request_id, f"Unsupported host URI operation: {operation}")
            return

        try:
            from urllib.parse import urlparse

            parsed = urlparse(url)
        except ValueError:
            self._send_host_uri_error(request_id, f"Could not parse host URI: {url}")
            return
        scheme = (parsed.scheme or "").lower()
        uri = next((candidate for candidate in self._host_uris if candidate.scheme == scheme), None)
        if uri is None:
            self._send_host_uri_error(request_id, f'Host URI scheme "{scheme}://" is not registered')
            return

        if operation == "write" and uri.write is None:
            self._send_host_uri_error(
                request_id, f'Host URI scheme "{scheme}://" was not registered with a write handler'
            )
            return

        pending = _PendingHostUriRequest(cancel_event=threading.Event())
        self._pending_host_uri_requests[request_id] = pending

        def run() -> None:
            try:
                context = HostUriContext(url=url, operation=cast(Any, operation), _cancel_event=pending.cancel_event)
                if operation == "read":
                    value = uri.read(url, context)
                    if pending.cancel_event.is_set():
                        return
                    result_fields = normalize_read_result(value)
                    self._send_notification(
                        {
                            "type": "host_uri_result",
                            "id": request_id,
                            **result_fields,
                        }
                    )
                else:
                    raw_content = payload.get("content")
                    content = str(raw_content) if raw_content is not None else ""
                    assert uri.write is not None
                    uri.write(url, content, context)
                    if pending.cancel_event.is_set():
                        return
                    self._send_notification({"type": "host_uri_result", "id": request_id})
            except Exception as exc:
                if pending.cancel_event.is_set():
                    return
                self._send_host_uri_error(request_id, str(exc))
            finally:
                self._pending_host_uri_requests.pop(request_id, None)

        threading.Thread(target=run, name=f"gjc-rpc-host-uri:{scheme}:{operation}", daemon=True).start()

    def _handle_host_uri_cancel(self, payload: JsonObject) -> None:
        target_id = payload.get("targetId")
        if not isinstance(target_id, str):
            return
        pending = self._pending_host_uri_requests.get(target_id)
        if pending is not None:
            pending.cancel_event.set()

    def _add_typed_event_listener(self, event_type: str, listener: TEventListener) -> Callable[[], None]:
        listeners = self._typed_event_listeners.setdefault(event_type, [])
        typed_listener = cast(AgentEventListener, listener)
        listeners.append(typed_listener)
        return lambda: self._remove_listener(listeners, typed_listener)

    @staticmethod
    def _normalize_todo_phases(todos: Sequence[TodoSeed | TodoPhaseSeed]) -> list[JsonObject]:
        if len(todos) == 0:
            return []

        next_task_id = 1

        def next_task() -> str:
            nonlocal next_task_id
            task_id = f"task-{next_task_id}"
            next_task_id += 1
            return task_id

        def normalize_todo_item(seed: TodoSeed) -> JsonObject:
            if isinstance(seed, str):
                return {"id": next_task(), "content": seed, "status": cast(JsonValue, "pending")}

            if isinstance(seed, TodoItem):
                if seed.status not in _TODO_STATUS_VALUES:
                    raise RpcError(f"Unsupported todo status: {seed.status}")
                return {
                    "id": seed.id or next_task(),
                    "content": seed.content,
                    "status": cast(JsonValue, seed.status),
                    "notes": seed.notes,
                    "details": seed.details,
                }

            content = seed.get("content")
            if not isinstance(content, str) or not content.strip():
                raise RpcError("Todo items must provide a non-empty 'content' value")

            raw_id = seed.get("id")
            raw_status = seed.get("status")
            raw_notes = seed.get("notes")
            raw_details = seed.get("details")
            if isinstance(raw_status, str):
                if raw_status not in _TODO_STATUS_VALUES:
                    raise RpcError(f"Unsupported todo status: {raw_status}")
                status: TodoStatus = cast(TodoStatus, raw_status)
            else:
                status = "pending"
            return {
                "id": str(raw_id) if isinstance(raw_id, str) and raw_id else next_task(),
                "content": content,
                "status": cast(JsonValue, status),
                "notes": raw_notes if isinstance(raw_notes, str) else None,
                "details": raw_details if isinstance(raw_details, str) else None,
            }

        def is_phase_seed(seed: TodoSeed | TodoPhaseSeed) -> bool:
            if isinstance(seed, TodoPhase):
                return True
            if not isinstance(seed, Mapping):
                return False
            return "tasks" in seed or ("name" in seed and "content" not in seed)

        def normalize_phase(seed: TodoPhaseSeed, index: int) -> JsonObject:
            if isinstance(seed, TodoPhase):
                phase_id = seed.id or f"phase-{index}"
                name = seed.name
                tasks = [normalize_todo_item(task) for task in seed.tasks]
            else:
                raw_name = seed.get("name")
                if not isinstance(raw_name, str) or not raw_name.strip():
                    raise RpcError("Todo phases must provide a non-empty 'name' value")
                phase_id_value = seed.get("id")
                raw_tasks = seed.get("tasks") or ()
                if not isinstance(raw_tasks, Sequence) or isinstance(raw_tasks, (str, bytes)):
                    raise RpcError("Todo phase 'tasks' must be a sequence")
                phase_id = str(phase_id_value) if isinstance(phase_id_value, str) and phase_id_value else f"phase-{index}"
                name = raw_name
                tasks = [normalize_todo_item(cast(TodoSeed, task)) for task in raw_tasks]

            return {"id": phase_id, "name": name, "tasks": tasks}

        if any(is_phase_seed(todo) for todo in todos):
            phases: list[JsonObject] = []
            for index, seed in enumerate(todos, start=1):
                if not is_phase_seed(seed):
                    raise RpcError("Cannot mix flat todo items with todo phases in one set_todos() call")
                phases.append(normalize_phase(cast(TodoPhaseSeed, seed), index))
            return phases

        return [{"id": "phase-1", "name": "Todos", "tasks": [normalize_todo_item(cast(TodoSeed, todo)) for todo in todos]}]

    def _build_command(self) -> tuple[str, ...]:
        if self._command is not None:
            return self._command

        command: list[str] = [self._executable, "--mode", "rpc"]
        if self._provider:
            command.extend(["--provider", self._provider])
        if self._model:
            command.extend(["--model", self._model])
        if self._session_dir is not None:
            command.extend(["--session-dir", str(self._session_dir)])
        if self._thinking is not None:
            command.extend(["--thinking", self._thinking])
        if self._append_system_prompt is not None:
            command.extend(["--append-system-prompt", self._append_system_prompt])
        if self._provider_session_id is not None:
            command.extend(["--provider-session-id", self._provider_session_id])
        if self._tools is not None:
            if len(self._tools) == 0:
                command.append("--no-tools")
            else:
                command.extend(["--tools", ",".join(self._tools)])
        if self._no_session:
            command.append("--no-session")
        if self._no_skills:
            command.append("--no-skills")
        if self._no_rules:
            command.append("--no-rules")
        emit_no_title = self._no_title if self._no_title is not None else self._rpc_defaults
        if emit_no_title:
            command.append("--no-title")
        command.extend(self._extra_args)
        return tuple(command)

    def _next_request_id(self) -> str:
        with self._state_lock:
            self._request_id += 1
            return f"req_{self._request_id}"

    def _require_process(self) -> subprocess.Popen[str]:
        if self._process is None:
            raise RpcError("RPC client is not started")
        return self._process

    def _write_json(self, process: subprocess.Popen[str], payload: JsonObject) -> None:
        if process.stdin is None:
            raise RpcProcessExitError("RPC process stdin is unavailable")
        with self._write_lock:
            try:
                process.stdin.write(json.dumps(payload))
                process.stdin.write("\n")
                process.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                raise RpcProcessExitError(f"Failed to write RPC command: {exc}") from exc

    def _read_stdout_loop(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return

        line_number = 0
        try:
            for line in process.stdout:
                line_number += 1
                stripped = line.strip()
                if not stripped:
                    continue

                try:
                    payload = cast(JsonObject, json.loads(stripped))
                except json.JSONDecodeError as exc:
                    snippet = stripped
                    if len(snippet) > 240:
                        snippet = f"{snippet[:237]}..."
                    raise RpcError(
                        f"Failed to decode RPC output on line {line_number}: {exc}. Frame: {snippet!r}"
                    ) from exc
                if payload.get("type") == "response":
                    self._handle_response(payload)
                    continue
                if payload.get("type") == "host_tool_call":
                    self._handle_host_tool_call(payload)
                    continue
                if payload.get("type") == "host_tool_cancel":
                    self._handle_host_tool_cancel(payload)
                    continue
                if payload.get("type") == "host_uri_request":
                    self._handle_host_uri_request(payload)
                    continue
                if payload.get("type") == "host_uri_cancel":
                    self._handle_host_uri_cancel(payload)
                    continue

                notification = parse_notification(payload)
                listener_notification = parse_notification(payload)
                self._dispatch_listeners(
                    "notification",
                    listener_notification.type,
                    self._notification_listeners,
                    listener_notification,
                )

                if isinstance(notification, ReadyEvent):
                    self._ready_received = True
                    self._ready.set()
                    self._dispatch_listeners("ready", listener_notification.type, self._ready_listeners, listener_notification)
                    continue

                if isinstance(notification, ExtensionUiRequest):
                    self._ui_requests.put(notification)
                    self._dispatch_listeners(
                        "ui_request",
                        listener_notification.type,
                        self._ui_request_listeners,
                        cast(ExtensionUiRequest, listener_notification),
                    )
                    continue


                if isinstance(notification, WorkflowGate):
                    self._workflow_gates.put(notification)
                    self._dispatch_listeners(
                        "workflow_gate",
                        listener_notification.type,
                        self._workflow_gate_listeners,
                        cast(WorkflowGate, listener_notification),
                    )
                    continue

                if isinstance(notification, ExtensionError):
                    self._dispatch_listeners(
                        "extension_error",
                        listener_notification.type,
                        self._extension_error_listeners,
                        cast(ExtensionError, listener_notification),
                    )
                    continue

                if isinstance(notification, UnknownNotification):
                    self._dispatch_listeners(
                        "unknown_notification",
                        listener_notification.type,
                        self._unknown_notification_listeners,
                        cast(UnknownNotification, listener_notification),
                    )
                    continue

                listener_event = cast(RpcAgentEvent, listener_notification)
                self._append_event(payload)
                if listener_event.type == "agent_end":
                    self._mark_agent_run_completed()
                self._dispatch_listeners("event", listener_event.type, self._event_listeners, listener_event)
                self._dispatch_listeners(
                    "typed_event", listener_event.type, self._typed_event_listeners.get(listener_event.type, []), listener_event
                )
        except Exception as exc:
            self._mark_closed(exc)
        else:
            if not self._stopping:
                exit_code = process.poll()
                if exit_code is None:
                    try:
                        exit_code = process.wait(timeout=1.0)
                    except subprocess.TimeoutExpired:
                        self._mark_closed(RpcProcessExitError("RPC process stdout closed before the process exited"))
                        return
                self._mark_closed(RpcProcessExitError(f"RPC process exited with code {exit_code}. Stderr: {self.stderr}"))

    def _read_stderr_loop(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        try:
            for chunk in process.stderr:
                with self._state_lock:
                    self._stderr_chunks.append(chunk)
        except Exception as exc:
            if not self._stopping:
                self._mark_closed(RpcError(f"Failed to read RPC stderr: {exc}"))

    def _mark_closed(self, error: BaseException) -> None:
        if self._closed_error is not None:
            return
        self._closed_error = error
        self._ready.set()
        self._fail_pending(error)
        with self._event_condition:
            self._event_condition.notify_all()

    def _fail_pending(self, error: BaseException) -> None:
        with self._state_lock:
            pending = [pending.response_queue for pending in self._pending.values()]
            self._pending.clear()
        for response_queue in pending:
            response_queue.put(error)

    def _handle_response(self, payload: JsonObject) -> None:
        request_id = payload.get("id")
        if isinstance(request_id, str):
            with self._state_lock:
                pending = self._pending.pop(request_id, None)
            if pending is not None:
                pending.response_queue.put(payload)
                return

        if self._deliver_correlated_error_response(payload):
            return

        protocol_error = self._build_protocol_error(payload)
        if protocol_error is None:
            return

        if protocol_error.command in _ASYNC_COMMANDS and protocol_error.remote_error is not None:
            self._append_async_error(RpcCommandError(protocol_error.command, protocol_error.remote_error))
            self._mark_agent_run_completed()

        self._record_protocol_error(protocol_error)

    def _deliver_correlated_error_response(self, payload: JsonObject) -> bool:
        if bool(payload.get("success", False)):
            return False

        command = payload.get("command")
        if not isinstance(command, str):
            return False

        with self._state_lock:
            matching_ids = [request_id for request_id, pending in self._pending.items() if pending.command == command]
            target_id: str | None = None
            if len(matching_ids) == 1:
                target_id = matching_ids[0]
            elif command == "parse" and len(self._pending) == 1:
                target_id = next(iter(self._pending))

            if target_id is None:
                return False

            pending = self._pending.pop(target_id)

        pending.response_queue.put(payload)
        return True

    def _build_protocol_error(self, payload: JsonObject) -> RpcProtocolError | None:
        if payload.get("type") != "response":
            return None
        if bool(payload.get("success", False)):
            return None
        return RpcProtocolError(_clone_json_object(payload))

    def _append_event(self, payload: JsonObject) -> None:
        with self._event_condition:
            self._events.append(_clone_json_object(payload))
            self._event_condition.notify_all()

    def _append_async_error(self, error: BaseException) -> None:
        with self._event_condition:
            self._async_errors.append(error)
            self._event_condition.notify_all()

    def _record_protocol_error(self, error: RpcProtocolError) -> None:
        with self._state_lock:
            self._protocol_errors.append(error)
        self._dispatch_listeners("protocol_error", error.command, self._protocol_error_listeners, error)

    def _record_listener_error(self, event: ListenerErrorEvent) -> None:
        with self._state_lock:
            self._listener_errors.append(event)

        for listener in list(self._listener_error_listeners):
            try:
                listener(event)
            except Exception:
                continue

    def _dispatch_listeners(
        self,
        listener_kind: str,
        source_type: str | None,
        listeners: Sequence[Callable[[Any], None]],
        payload: Any,
    ) -> None:
        for listener in list(listeners):
            try:
                listener(payload)
            except Exception as exc:
                self._record_listener_error(
                    ListenerErrorEvent(
                        listener_kind=listener_kind,
                        source_type=source_type,
                        listener=listener,
                        error=exc,
                    )
                )

    @staticmethod
    def _validate_history_limit(name: str, limit: int | None) -> int | None:
        if limit is None:
            return None
        if limit <= 0:
            raise ValueError(f"{name} must be greater than zero")
        return limit

    @staticmethod
    def _remove_listener(listeners: list[TListener], listener: TListener) -> None:
        try:
            listeners.remove(listener)
        except ValueError:
            pass
