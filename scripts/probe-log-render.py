#!/usr/bin/env python3
"""Render the probe sink's log as the panes the phone showed.

nginx writes one line per report: an ISO timestamp, then the JSON body the
page POSTed. The body carries the session, the step and the pane's full text,
so this reassembles them in order — the point being that the numbers arrive as
text that can be grepped and diffed, rather than as a photograph.

Reads stdin, so it works the same on `cat` and on `tail -f`.
"""

from __future__ import annotations

import json
import sys

RULE = "─" * 66


def emit(stamp: str, body: str) -> None:
    try:
        report = json.loads(body)
    except json.JSONDecodeError:
        # Anything that is not our page — a stray POST while the sink was up.
        print(f"{stamp}  [unparsable] {body[:200]}")
        return
    if not isinstance(report, dict):
        print(f"{stamp}  [not a report] {body[:200]}")
        return

    session = str(report.get("session", "?"))
    step = str(report.get("step", "?"))
    text = report.get("text", "")

    print(f"\n{RULE}\n{stamp}  session {session}  ·  {step}\n{RULE}")
    print(text if isinstance(text, str) else json.dumps(text, indent=2))
    sys.stdout.flush()


def main() -> None:
    for raw in sys.stdin:
        line = raw.rstrip("\n")
        if not line:
            continue
        # `log_format probe escape=json '$time_iso8601 $request_body'` — the
        # timestamp has no spaces, so one split separates it from the body.
        stamp, _, body = line.partition(" ")
        body = body.strip()
        # `escape=json` escapes the field's contents — `"` becomes `\"` — but
        # does not wrap the field in quotes, because the log_format does not.
        # Supplying the quotes turns it back into the body that was POSTed.
        try:
            body = json.loads(f'"{body}"')
        except json.JSONDecodeError:
            pass
        if body in ("", "-"):
            continue
        emit(stamp, body)


if __name__ == "__main__":
    main()
