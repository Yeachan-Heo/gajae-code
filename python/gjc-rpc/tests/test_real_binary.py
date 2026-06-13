"""Real-binary integration lane for gjc_rpc (issue 08).

The rest of the suite runs against a hand-written fake server, which cannot catch
client/server drift (e.g. a dropped `contextUsage` field or a missing typed
method). This lane drives the real `gjc --mode rpc` binary over the no-model
control surface so the typed client is checked against the actual protocol.

Opt-in: set ``GJC_RPC_REAL_BINARY=1`` and have ``bun`` on PATH. It is skipped
otherwise so default/offline runs stay fast.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path

from gjc_rpc import RpcClient, RpcCommandError, UnattendedBudget

_REPO_ROOT = Path(__file__).resolve().parents[3]
_CLI = _REPO_ROOT / "packages" / "coding-agent" / "src" / "cli.ts"
_ENABLED = (
    os.environ.get("GJC_RPC_REAL_BINARY") == "1"
    and shutil.which("bun") is not None
    and _CLI.is_file()
)


@unittest.skipUnless(_ENABLED, "set GJC_RPC_REAL_BINARY=1 with bun on PATH to run the real-binary lane")
class RealBinaryRpcTest(unittest.TestCase):
    def _client(self, tmp: str) -> RpcClient:
        env = dict(os.environ)
        env.setdefault("ANTHROPIC_API_KEY", "sk-ant-real-binary-test")
        env["GJC_CODING_AGENT_DIR"] = os.path.join(tmp, ".agent")
        return RpcClient(
            command=[
                "bun",
                str(_CLI),
                "--mode",
                "rpc",
                "--provider",
                "anthropic",
                "--model",
                "claude-sonnet-4-5",
                "--no-session",
                "--no-skills",
                "--no-rules",
            ],
            cwd=tmp,
            env=env,
            startup_timeout=60.0,
            request_timeout=45.0,
        )

    def test_get_state_round_trips_context_usage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, self._client(tmp) as client:
            state = client.get_state()
            self.assertIsNotNone(state.model)
            self.assertIsNotNone(state.context_usage)
            assert state.context_usage is not None
            self.assertGreater(state.context_usage.context_window, 0)

    def test_invalid_thinking_level_is_a_correlated_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, self._client(tmp) as client:
            with self.assertRaises(RpcCommandError) as caught:
                client.set_thinking_level("BOGUS")  # type: ignore[arg-type]
            # The failure is correlated to the real command, not a generic "parse".
            self.assertEqual(caught.exception.command, "set_thinking_level")

    def test_negotiate_unattended_round_trips_with_floor(self) -> None:
        budget = UnattendedBudget(
            max_tokens=1000, max_tool_calls=10, max_wall_time_ms=60_000, max_cost_usd=1
        )
        with tempfile.TemporaryDirectory() as tmp, self._client(tmp) as client:
            accepted = client.negotiate_unattended(
                actor="real-binary-test",
                budget=budget,
                scopes=["message:read"],
                action_allowlist=["command.message_read"],
            )
            self.assertEqual(accepted.actor, "real-binary-test")
            # Mandatory floor is merged server-side and reflected back.
            self.assertIn("prompt", accepted.scopes)
            self.assertIn("command.prompt", accepted.action_allowlist)

    def test_negotiate_unattended_rejects_unknown_scope(self) -> None:
        budget = UnattendedBudget(
            max_tokens=1000, max_tool_calls=10, max_wall_time_ms=60_000, max_cost_usd=1
        )
        with tempfile.TemporaryDirectory() as tmp, self._client(tmp) as client:
            with self.assertRaises(RpcCommandError):
                client.negotiate_unattended(
                    actor="x",
                    budget=budget,
                    scopes=["not-a-real-scope"],
                    action_allowlist=[],
                )

    def test_live_session_appears_in_registry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, self._client(tmp) as client:
            state = client.get_state()
            registry_dir = os.path.join(tmp, ".agent", "rpc-sessions")
            handles = RpcClient.list_sessions(sessions_dir=registry_dir)
            self.assertIn(state.session_id, [h.session_id for h in handles])


if __name__ == "__main__":
    unittest.main()
