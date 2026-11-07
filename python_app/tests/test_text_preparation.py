from __future__ import annotations

import json

import pytest

import comic_studio.text_preparation as preparation
from comic_studio.text_preparation import (
    TRANSLATION_INSTRUCTION,
    TextPreparationError,
    prepare_translation_units,
    translate_prepared,
)


def line(text, y0=0, x0=0, height=10, **metadata):
    return {
        "text": text,
        "x0": x0,
        "y0": y0,
        "x1": x0 + 100,
        "y1": y0 + height,
        **metadata,
    }


def test_bubbles_join_lines_dehyphenate_and_split_on_large_vertical_gap():
    units = prepare_translation_units([
        line("  First   ", 0, region="a"),
        line("line  ", 12, region="a"),
        line("some-", 40, region="a"),
        line("thing", 52, region="a"),
    ], mode="bubble")
    assert units == [
        {"id": 1, "text": "First line"},
        {"id": 2, "text": "something"},
    ]


def test_all_bubbles_on_one_page_share_one_request():
    calls = []

    def request(prompt):
        payload = json.loads(prompt)
        calls.append(payload)
        return [{"id": item["id"], "text": f"ترجمهٔ {item['id']}"} for item in payload["items"]]

    result = translate_prepared([
        line("Left first", 0, region="left", page="page-1"),
        line("Left second", 12, region="left", page="page-1"),
        line("Right bubble", 2, region="right", page="page-1"),
    ], request, mode="bubble")

    assert len(calls) == 1
    assert [item["id"] for item in calls[0]["items"]] == [1, 2]
    assert calls[0]["items"][0]["text"] == "Left first Left second"
    assert result == [{"id": 1, "text": "ترجمهٔ 1"}, {"id": 2, "text": "ترجمهٔ 2"}]


def test_document_paragraph_boundaries_include_gap_blank_line_and_indent():
    units = prepare_translation_units([
        line("one", 0),
        line("two", 12),
        line("vertical gap", 30),
        line("", 42),
        line("after blank", 54),
        line("indented first line", 66, x0=20),
    ], mode="document")
    assert [unit["text"] for unit in units] == [
        "one two", "vertical gap", "after blank", "indented first line",
    ]


def test_document_special_units_stay_separate_and_code_formula_keep_exact_text():
    units = prepare_translation_units([
        line("Title", 0, kind="heading"),
        line("Paragraph", 12),
        line("continues", 24),
        line("First item", 36, kind="list_item"),
        line("Cell", 48, kind="table_cell"),
        line(" x =  1 ", 60, kind="formula"),
        line("print(  1 )", 72, kind="code", unit_id="code-1"),
        line("  return 2", 84, kind="code", unit_id="code-1"),
        line("Next paragraph", 96),
    ], mode="document")
    assert [unit["text"] for unit in units] == [
        "Title", "Paragraph continues", "First item", "Cell", " x =  1 ",
        "print(  1 )\n  return 2", "Next paragraph",
    ]


def test_formula_and_code_are_not_sent_and_return_verbatim():
    calls = []

    def request(prompt):
        payload = json.loads(prompt)
        calls.append(payload)
        return [{"id": item["id"], "text": f"ترجمهٔ {item['id']}"} for item in payload["items"]]

    source = [
        line("Title", 0, kind="heading"),
        line("Paragraph", 12),
        line("Item", 24, kind="list_item"),
        line("Cell", 36, kind="table_cell"),
        line(" x =  1 ", 48, kind="formula"),
        line("print(  1 )", 60, kind="code"),
        line("Next paragraph", 72),
    ]
    result = translate_prepared(source, request, mode="document")

    assert len(calls) == 1
    assert [item["id"] for item in calls[0]["items"]] == [1, 2, 3, 4, 7]
    assert result[4] == {"id": 5, "text": " x =  1 "}
    assert result[5] == {"id": 6, "text": "print(  1 )"}


def test_document_batches_only_between_paragraphs():
    calls = []

    def request(prompt):
        payload = json.loads(prompt)
        calls.append(payload["items"])
        return [{"id": item["id"], "text": "ترجمه"} for item in payload["items"]]

    translate_prepared([
        line("A" * 12 + ".", 0),
        line("", 10),
        line("B" * 12 + ".", 20),
        line("", 30),
        line("C" * 12 + ".", 40),
    ], request, mode="document", batch_size=26)

    assert [[item["id"] for item in batch] for batch in calls] == [[1, 2], [3]]
    assert [item["text"] for batch in calls for item in batch] == ["A" * 12 + ".", "B" * 12 + ".", "C" * 12 + "."]


def test_only_oversized_paragraph_is_split_at_sentence_boundaries_and_logged(monkeypatch):
    calls = []
    logs = []
    monkeypatch.setattr(preparation, "emit", lambda message, kind="info": logs.append((message, kind)))

    def request(prompt):
        payload = json.loads(prompt)
        calls.append(payload["items"])
        return [{"id": 1, "text": f"بخش {len(calls)}"}]

    text = " ".join(["A" * 20 + ".", "B" * 20 + ".", "C" * 20 + "."])
    result = translate_prepared([line(text, 0)], request, mode="document", batch_size=25)

    assert len(calls) == 3
    assert all(len(batch) == 1 and batch[0]["text"].endswith(".") for batch in calls)
    assert result == [{"id": 1, "text": "بخش 1 بخش 2 بخش 3"}]
    assert any("last resort" in message and kind == "warning" for message, kind in logs)


def test_single_long_sentence_is_not_broken():
    calls = []

    def request(prompt):
        payload = json.loads(prompt)
        calls.append(payload["items"])
        return [{"id": 1, "text": "ترجمه"}]

    text = "A" * 80
    result = translate_prepared([line(text, 0)], request, mode="document", batch_size=20)
    assert calls == [[{"id": 1, "text": text}]]
    assert result == [{"id": 1, "text": "ترجمه"}]


def test_glossary_is_updated_after_each_batch_and_previous_paragraph_is_context_only():
    calls = []

    def request(prompt):
        payload = json.loads(prompt)
        calls.append(payload)
        translations = {1: "پاراگراف اول", 2: "رابط برنامه‌نویسی", 3: "پاراگراف دوم"}
        return [{"id": item["id"], "text": translations[item["id"]]} for item in payload["items"]]

    glossary = {"AI": "هوش مصنوعی"}
    result = translate_prepared([
        line("First paragraph.", 0),
        line("API", 20, kind="term"),
        line("Second paragraph.", 40),
    ], request, mode="document", glossary=glossary, batch_size=18)

    assert len(calls) == 3
    assert calls[0]["glossary"] == {"AI": "هوش مصنوعی"}
    assert calls[2]["glossary"]["API"] == "رابط برنامه‌نویسی"
    assert glossary["API"] == "رابط برنامه‌نویسی"
    context = calls[2]["context"]
    assert context["text"] == "First paragraph."
    assert "ترجمه نکن" in context["instruction"]
    assert TRANSLATION_INSTRUCTION in calls[0]["instruction"]
    assert result[2]["text"] == "پاراگراف دوم"


def test_mismatched_output_count_retries_same_batch_once():
    calls = []

    def request(prompt):
        payload = json.loads(prompt)
        calls.append(payload)
        if len(calls) == 1:
            return [{"id": 1, "text": "فقط یکی"}]
        return [{"id": 1, "text": "یک"}, {"id": 2, "text": "دو"}]

    result = translate_prepared([line("one", 0, region="a"), line("two", 30, region="b")], request)
    assert len(calls) == 2
    assert calls[0] == calls[1]
    assert result == [{"id": 1, "text": "یک"}, {"id": 2, "text": "دو"}]


def test_second_mismatched_output_fails_without_more_retries():
    calls = []

    def request(prompt):
        calls.append(prompt)
        return [{"id": 1, "text": "ناقص"}]

    with pytest.raises(TextPreparationError):
        translate_prepared([line("one", 0, region="a"), line("two", 30, region="b")], request)
    assert len(calls) == 2
