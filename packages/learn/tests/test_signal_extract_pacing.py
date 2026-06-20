"""Tests for the signal-extract burst-pacing patch (fix/signal-extract-pacing).

``SignalExtractWorkflow`` processes unprocessed stream events in chunks of
``EXTRACT_CHUNK_SIZE`` concurrent ``extract_signals_from_event`` activities,
chunk after chunk. The ``signal_extract_pace_v1`` patch lowers the chunk
size to 5 and inserts a durable inter-chunk sleep so the back-to-back
chunks stay under the openai-codex *per-minute burst* limit (the cap-aware
backoff from #268 handles the long-window usage cap; this handles the
short-window burst limit that 16-concurrent chunks briefly tripped).

Stubbing strategy matches ``test_plane_reverse_sync_workflow.py`` /
``test_task_closure_workflow.py`` — replacement activities registered
under the same name via ``@activity.defn(name=...)`` so the workflow runs
end-to-end through ``WorkflowEnvironment.start_time_skipping`` without
touching ctrl-api or clerk. The time-skipping environment treats every run
as fresh history, so ``workflow.patched("signal_extract_pace_v1")`` is
active and the durable ``asyncio.sleep`` is fast-forwarded (no wall clock).
"""
from __future__ import annotations

import uuid
from typing import Any

from temporalio import activity
from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from src.workflows.signals import SignalExtractResult, SignalExtractWorkflow


# ---------------------------------------------------------------------------
# Stub activities — registered under the real names the workflow dispatches.
# ---------------------------------------------------------------------------


def _make_stubs(*, n_events: int) -> tuple[list, dict[str, Any]]:
    """Replacement activities for one workflow run.

    ``state`` accumulates observable side effects:
      * ``extracted`` — paths passed to the extractor (call order).
      * ``marked`` — paths passed to mark_stream_event_processed.
      * ``log`` — unified ("extract"|"mark", path) event log. The workflow
        extracts a whole chunk (one ``asyncio.gather``) and only then
        writes+marks that chunk before dispatching the next, so the log
        interleaves per chunk: 5 extracts, 5 marks, 5 extracts, ... . The
        index of the first ``mark`` therefore reveals the chunk boundary
        (== EXTRACT_CHUNK_SIZE). Under the legacy size of 16, all events
        would be extracted before any mark.
    """
    state: dict[str, Any] = {
        "extracted": [],
        "marked": [],
        "log": [],
    }

    paths = [f"stream_event/evt-{i:03d}.md" for i in range(n_events)]

    @activity.defn(name="list_unprocessed_stream_events")
    async def stub_list(
        since: str | None = None,
        limit: int = 100,
        types: list[str] | None = None,
    ) -> list[str]:
        return list(paths)

    @activity.defn(name="extract_signals_from_event")
    async def stub_extract_multi(path: str) -> list[dict[str, Any]]:
        state["extracted"].append(path)
        state["log"].append(("extract", path))
        # Return one signal so write_signal_record + mark both run, giving
        # the per-chunk interleaving the chunk-size assertion relies on.
        return [{"raw_quote": path, "effect": "none"}]

    @activity.defn(name="extract_signal_from_event")
    async def stub_extract_single(path: str) -> dict[str, Any] | None:
        # Legacy single-signal branch — not taken under fresh history
        # (multi-signal patch is active) but registered for completeness.
        return None

    @activity.defn(name="write_signal_record")
    async def stub_write(extracted_signal: dict[str, Any]) -> str:
        return "signal/stub.md"

    @activity.defn(name="extract_observation_from_signal")
    async def stub_obs(signal_path: str) -> dict[str, Any]:
        return {"ok": True}

    @activity.defn(name="mark_stream_event_processed")
    async def stub_mark(
        stream_event_path: str, signal_path: str | None = None
    ) -> None:
        state["marked"].append(stream_event_path)
        state["log"].append(("mark", stream_event_path))

    stubs = [
        stub_list,
        stub_extract_multi,
        stub_extract_single,
        stub_write,
        stub_obs,
        stub_mark,
    ]
    return stubs, state


async def _run_workflow(stubs: list) -> SignalExtractResult:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"signal-pace-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[SignalExtractWorkflow],
            activities=stubs,
            # The extractor stub mutates shared test state; keep the
            # activity executor in-thread (default async activities run on
            # the event loop, so the shared dict is safe).
        )
        async with worker:
            result: SignalExtractResult = await client.execute_workflow(
                SignalExtractWorkflow.run,
                id=f"signal-pace-run-{uuid.uuid4()}",
                task_queue=tq,
            )
    return result


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def _chunk_size_from_log(log: list[tuple[str, str]]) -> int:
    """Effective chunk size = number of consecutive ``extract`` events
    before the first ``mark``. The workflow extracts a whole chunk, then
    writes+marks it before the next chunk's extracts begin."""
    size = 0
    for kind, _ in log:
        if kind == "extract":
            size += 1
        else:  # first mark closes the first chunk
            break
    return size


async def test_pace_flag_limits_chunk_to_five() -> None:
    """With signal_extract_pace_v1 active (fresh history), EXTRACT_CHUNK_SIZE
    is 5, NOT the legacy 16. Twelve events => three chunks of 5/5/2, so the
    first chunk extracts exactly 5 events before marking any. Under the
    legacy size of 16 all 12 would be extracted before the first mark."""
    stubs, state = _make_stubs(n_events=12)
    result = await _run_workflow(stubs)

    assert result.started is True
    assert result.listed == 12
    # All 12 events were extracted and marked processed (durable, per chunk).
    assert len(state["extracted"]) == 12
    assert len(state["marked"]) == 12
    # The chunk boundary lands at 5 — the pace patch's lowered concurrency.
    assert _chunk_size_from_log(state["log"]) == 5
    # Sanity: the run did chunk (a mark appears before all extracts finish).
    assert state["log"].count(("extract", "stream_event/evt-000.md")) == 1


async def test_pace_flag_completes_without_error() -> None:
    """The new flag is wired end-to-end and doesn't break the happy path:
    a single short batch (< one chunk) still drains cleanly. With 3 events
    there is only one chunk, so no inter-chunk delay is applied (the
    durable sleep is skipped after the final chunk)."""
    stubs, state = _make_stubs(n_events=3)
    result = await _run_workflow(stubs)

    assert result.started is True
    assert result.listed == 3
    assert result.errors == 0
    assert len(state["extracted"]) == 3
    assert len(state["marked"]) == 3
    # One chunk of <=5: all 3 extract before any mark.
    assert _chunk_size_from_log(state["log"]) == 3
