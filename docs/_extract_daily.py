"""Extract user queries by day from agent transcript for progress summary."""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

TRANSCRIPT = Path(
    r"C:\Users\Isaac Chia\.cursor\projects\c-Users-Isaac-Chia-INFER"
    r"\agent-transcripts\df8b94f6-ab25-4534-bcc8-e7f61a1d6d51"
    r"\df8b94f6-ab25-4534-bcc8-e7f61a1d6d51.jsonl"
)

TS = re.compile(r"<timestamp>([^<]+)</timestamp>")
# e.g. Thursday, Aug 20, 2026, 4:52 PM (UTC+8)
DAY = re.compile(r"^(.*?),\s+(\d{1,2}:\d{2}\s*[AP]M)")


def text_of(msg: dict) -> str:
    content = msg.get("message", {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text") or "")
        return "\n".join(parts)
    return ""


def main() -> None:
    by_day: dict[str, list[str]] = defaultdict(list)
    with TRANSCRIPT.open(encoding="utf-8") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("role") != "user":
                continue
            raw = text_of(obj)
            m = TS.search(raw)
            if not m:
                continue
            ts = m.group(1).strip()
            # day key: "Thursday, Aug 20, 2026"
            day = ts.rsplit(",", 1)[0].rsplit(",", 1)
            # "Thursday, Aug 20, 2026, 4:52 PM (UTC+8)" -> split off time
            day_key = re.sub(r",\s*\d{1,2}:\d{2}\s*[AP]M.*$", "", ts).strip()
            # strip user_query tags
            q = re.sub(r"</?user_query>", "", raw)
            q = TS.sub("", q).strip()
            q = re.sub(r"\s+", " ", q)
            if len(q) > 220:
                q = q[:217] + "..."
            if q and not q.startswith("<") and "system_notification" not in q:
                by_day[day_key].append(q)

    out = Path(r"C:\Users\Isaac Chia\INFER\docs\_daily_queries.json")
    payload = {k: v for k, v in sorted(by_day.items(), key=lambda kv: kv[0])}
    # sort days chronologically roughly by parsing
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print("days", len(payload))
    for d, qs in payload.items():
        print(d, "queries=", len(qs))


if __name__ == "__main__":
    main()
