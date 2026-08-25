"""
Append (or merge) a day section into docs/INFER-daily-progress-summary.docx.

Usage (from repo root, with backend venv):
  backend/.venv/Scripts/python.exe docs/_append_daily_progress.py ^
    --date "Thursday, 21 August 2026" ^
    --progress "Did X" "Did Y" ^
    --problems "Hit Z" ^
    --solutions "Fixed by W"
"""

from __future__ import annotations

import argparse
from pathlib import Path

from docx import Document
from docx.text.paragraph import Paragraph

ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = ROOT / "docs" / "INFER-daily-progress-summary.docx"


def _iter_headings(doc: Document) -> list[tuple[int, str, Paragraph]]:
    out: list[tuple[int, str, Paragraph]] = []
    for p in doc.paragraphs:
        if p.style and p.style.name.startswith("Heading"):
            level = int(p.style.name.replace("Heading ", "") or "0")
            out.append((level, (p.text or "").strip(), p))
    return out


def _find_day_heading(doc: Document, date: str) -> Paragraph | None:
    for level, text, p in _iter_headings(doc):
        if level == 1 and text == date:
            return p
    return None


def _add_section(doc: Document, title: str, items: list[str]) -> None:
    p = doc.add_paragraph()
    run = p.add_run(title)
    run.bold = True
    for item in items:
        item = item.strip()
        if item:
            doc.add_paragraph(item, style="List Bullet")


def append_day(date: str, progress: list[str], problems: list[str], solutions: list[str]) -> str:
    if not DOC_PATH.exists():
        raise SystemExit(f"Missing {DOC_PATH}")

    doc = Document(str(DOC_PATH))
    existing = _find_day_heading(doc, date)
    if existing is not None:
        # Merge: append bullets under new Progress/Problems/Solutions blocks at end of doc
        # (simple merge — agent may refine in place for complex edits)
        doc.add_paragraph()
        note = doc.add_paragraph()
        r = note.add_run(f"(Additional notes for {date})")
        r.italic = True
        _add_section(doc, "Progress", progress)
        _add_section(doc, "Problems", problems)
        _add_section(doc, "Solutions", solutions)
        doc.save(str(DOC_PATH))
        return f"merged into existing day: {date}"

    doc.add_heading(date, level=1)
    _add_section(doc, "Progress", progress)
    _add_section(doc, "Problems", problems)
    _add_section(doc, "Solutions", solutions)
    doc.save(str(DOC_PATH))
    return f"appended new day: {date}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True, help='e.g. "Thursday, 21 August 2026"')
    ap.add_argument("--progress", nargs="*", default=[])
    ap.add_argument("--problems", nargs="*", default=[])
    ap.add_argument("--solutions", nargs="*", default=[])
    args = ap.parse_args()
    if not (args.progress or args.problems or args.solutions):
        raise SystemExit("Provide at least one of --progress / --problems / --solutions")
    msg = append_day(args.date, args.progress, args.problems, args.solutions)
    print(msg)
    print(DOC_PATH)


if __name__ == "__main__":
    main()
