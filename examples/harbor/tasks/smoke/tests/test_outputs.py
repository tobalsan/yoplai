"""Smoke test verifier — asserts the yoplai eval CLI contract works."""
import json
import pathlib

RESULT = pathlib.Path("/logs/agent/result.json")
REWARD = pathlib.Path("/logs/verifier/reward.json")


def test_result_exists():
    assert RESULT.exists(), "result.json was not written"


def test_status_completed():
    result = json.loads(RESULT.read_text())
    assert result["status"] == "completed", f"status={result.get('status')}"


def test_final_message_contains_ok():
    result = json.loads(RESULT.read_text())
    msg = result.get("finalMessage", "")
    assert "ok" in msg.lower(), f"finalMessage missing 'ok': {msg[:200]}"
