from comic_studio.ocr_grouping import group_ocr_lines


def line(number, text, x, y, width=120, height=20):
    return {"id": number, "text": text, "tr": "", "richHtml": "", "conf": 90,
            "x0": x, "y0": y, "x1": x + width, "y1": y + height,
            "lineH": height, "enabled": True, "bg": "auto"}


def test_nearby_lines_form_one_reversible_paragraph():
    source = [line(1, "WHY ARE YOU", 20, 10), line(2, "RUNNING AROUND", 20, 35),
              line(3, "SO FRIVOLOUSLY,", 20, 60), line(4, "MY CHILD?", 20, 85)]
    result = group_ocr_lines(source)
    assert len(result) == 1
    block = result[0]
    assert block['text'] == 'WHY ARE YOU RUNNING AROUND SO FRIVOLOUSLY, MY CHILD?'
    assert (block['x0'], block['y0'], block['x1'], block['y1']) == (20, 10, 140, 105)
    assert [entry['text'] for entry in block['sourceLines']] == [entry['text'] for entry in source]
    assert block['lineH'] == 20
    assert source[0]['text'] == 'WHY ARE YOU'


def test_separate_columns_and_large_vertical_gap_do_not_merge():
    result = group_ocr_lines([line(1, 'LEFT 1', 10, 10), line(2, 'RIGHT 1', 200, 10),
                              line(3, 'LEFT 2', 10, 35), line(4, 'RIGHT 2', 200, 35),
                              line(5, 'NEXT BUBBLE', 10, 130)])
    assert [block['text'] for block in result] == ['LEFT 1 LEFT 2', 'RIGHT 1 RIGHT 2', 'NEXT BUBBLE']


def test_ambiguous_nearest_groups_are_not_combined():
    result = group_ocr_lines([line(1, 'one', 0, 0, 80), line(2, 'two', 100, 0, 80),
                              line(3, 'uncertain', 50, 25, 80)])
    assert len(result) == 3


def test_detect_page_mode_distinguishes_comics_from_books_and_two_column_articles():
    from comic_studio.ocr_grouping import detect_page_mode

    comic_sample = [
        line(1, "WHY ARE YOU", 20, 10),
        line(2, "RUNNING AROUND", 20, 35),
        line(3, "SO FRIVOLOUSLY,", 20, 60),
        line(4, "MY CHILD?", 20, 85),
    ]
    assert detect_page_mode(comic_sample, page_size=(800, 1200)) == "comic"

    book_page = [
        line(i + 1, f"This is a full book prose line number {i + 1} with natural lowercase text.", 80, 60 + i * 28, width=620, height=20)
        for i in range(8)
    ]
    assert detect_page_mode(book_page, page_size=(800, 1200)) == "document"

    two_col_article = [
        line(1, "Left column sentence one in article.", 60, 100, width=300, height=18),
        line(2, "Right column sentence one in article.", 430, 100, width=300, height=18),
        line(3, "Left column sentence two continues.", 60, 124, width=300, height=18),
        line(4, "Right column sentence two continues.", 430, 124, width=300, height=18),
        line(5, "Left column sentence three ends.", 60, 148, width=260, height=18),
        line(6, "Right column sentence three ends.", 430, 148, width=260, height=18),
    ]
    assert detect_page_mode(two_col_article, page_size=(800, 1200)) == "document"


def test_two_column_article_reading_order_and_document_paragraph_grouping():
    from comic_studio.ocr_grouping import organize_ocr_blocks

    # Interleaved Y-sorted lines from a 2-column academic article with spanning title + footer:
    raw_lines = [
        line(1, "1. Introduction to Modern Physics", 80, 30, width=640, height=28),
        line(2, "Quantum mechanics describes nature at", 80, 90, width=290, height=18),
        line(3, "• First experimental observation", 430, 90, width=290, height=18),
        line(4, "the smallest scales of phenom-", 80, 114, width=290, height=18),
        line(5, "• Second mathematical postulate", 430, 114, width=290, height=18),
        line(6, "ena in atomic systems.", 80, 138, width=180, height=18),
        line(7, "    A new indented paragraph begins", 112, 162, width=258, height=18),
        line(8, "right below the first paragraph.", 80, 186, width=275, height=18),
        line(9, "Journal of Physics — Page 42", 80, 920, width=640, height=16),
    ]
    blocks, resolved = organize_ocr_blocks(raw_lines, page_mode="auto", group_lines=True, page_size=(800, 1000))
    assert resolved == "document"
    texts = [b["text"] for b in blocks]
    assert texts == [
        "1. Introduction to Modern Physics",
        "Quantum mechanics describes nature at the smallest scales of phenomena in atomic systems.",
        "A new indented paragraph begins right below the first paragraph.",
        "• First experimental observation",
        "• Second mathematical postulate",
        "Journal of Physics — Page 42",
    ]
    assert blocks[0]["pageRole"] == "heading" and blocks[0]["bold"] is True
    assert blocks[1]["pageRole"] == "paragraph" and blocks[1]["bold"] is False
    assert len(blocks[1]["sourceLines"]) == 3
    assert blocks[3]["pageRole"] == "list" and blocks[4]["pageRole"] == "list"


def test_weighted_confidence_ignores_empty_member_offset():
    from comic_studio.ocr_grouping import _group_comic_lines, group_document_lines

    comic_members = [
        {"id": 1, "text": "   ", "conf": 11.0, "x0": 40, "y0": 40, "x1": 180, "y1": 62},
        {"id": 2, "text": "Real bubble text", "conf": 95.0, "x0": 42, "y0": 66, "x1": 182, "y1": 88},
    ]
    comic_grouped = _group_comic_lines(comic_members)
    assert len(comic_grouped) == 1
    assert comic_grouped[0]["text"] == "Real bubble text"
    assert comic_grouped[0]["conf"] == 95.0

    doc_members = [
        {"id": 1, "text": "", "conf": 12.0, "x0": 50, "y0": 100, "x1": 520, "y1": 122},
        {"id": 2, "text": "Paragraph line with reliable OCR confidence here", "conf": 94.0, "x0": 50, "y0": 126, "x1": 520, "y1": 148},
    ]
    doc_grouped = group_document_lines(doc_members, page_size=(600, 900))
    assert len(doc_grouped) == 1
    assert doc_grouped[0]["conf"] == 94.0


def test_v389_ipc_headings_line_breaks_indents_outdents_and_auto_doc_promotion():
    from comic_studio.ocr_grouping import organize_ocr_blocks

    def _line(idx, text, x0, y0, x1, y1):
        return line(idx, text, x0, y0, width=x1 - x0, height=y1 - y0)

    raw_ipc_lines = [
        # Deep 5-level IPC heading at normal body height (22px)
        _line(1, "8.3.5.7.1 Minimum Heel Fillet Height", 80, 60, 420, 82),
        # IPC condition header without period at normal height
        _line(2, "Target - Class 1, 2, 3", 80, 98, 290, 120),
        # Hanging-indented bullet item (first line at x0=80, wrapped continuation at x0=112)
        _line(3, "• Smooth concave solder fillet across the entire lead", 80, 130, 710, 152),
        _line(4, "termination interface.", 112, 158, 320, 180),
        # Visually bold standalone sub-title at body height
        {**_line(5, "Dimensional Criteria", 80, 198, 275, 220), "bold": True, "_detectedBold": True, "_explicitBold": True},
        # Stacked short lines WITHOUT periods (must NOT concatenate onto one line!)
        _line(6, "Class 1: Minimum 50% lead thickness", 80, 230, 390, 252),
        _line(7, "Class 2: Minimum 75% lead thickness", 80, 258, 392, 280),
        # First-line indented prose paragraph (x0=118 -> x0=80)
        _line(8, "The solder joint shall wet both the lead heel and the land", 118, 300, 712, 322),
        _line(9, "without bridging adjacent conductors.", 80, 328, 430, 350),
        # Outdented warning callout sticking left of the 80px margin (x0=44)
        _line(10, "NOTE: Verify magnification per Table 1-2.", 44, 370, 430, 392),
        # Figure caption & ALL-CAPS title
        _line(11, "Figure 8-35 Butt/I Lead Heel Fillet", 80, 412, 410, 434),
        _line(12, "GENERAL SOLDERING REQUIREMENTS", 80, 452, 430, 474),
    ]

    # Even if user leaves page_mode="comic", unmistakable IPC/document structure promotes to "document"
    blocks, resolved = organize_ocr_blocks(raw_ipc_lines, page_mode="comic", group_lines=True, page_size=(800, 1000))
    assert resolved == "document"

    by_text = {b["text"]: b for b in blocks}
    assert by_text["8.3.5.7.1 Minimum Heel Fillet Height"]["pageRole"] == "heading"
    assert by_text["Target - Class 1, 2, 3"]["pageRole"] == "heading"
    assert by_text["Dimensional Criteria"]["pageRole"] == "heading"
    assert by_text["Figure 8-35 Butt/I Lead Heel Fillet"]["pageRole"] == "heading"
    assert by_text["GENERAL SOLDERING REQUIREMENTS"]["pageRole"] == "heading"

    # Explicit short lines stay separate instead of concatenating behind each other
    assert "Class 1: Minimum 50% lead thickness" in by_text
    assert "Class 2: Minimum 75% lead thickness" in by_text

    # Hanging indent on wrapped bullet item
    bullet_blk = next(b for b in blocks if b["text"].startswith("• Smooth concave"))
    assert bullet_blk["pageRole"] == "list"
    assert bullet_blk.get("hangingIndent", 0) >= 1.0

    # First-line indent on indented prose paragraph
    ind_blk = next(b for b in blocks if b["text"].startswith("The solder joint"))
    assert ind_blk["pageRole"] == "paragraph"
    assert ind_blk.get("firstLineIndent", 0) >= 1.2

    # Outdented callout gets blockOutdent > 0 and sourceIndent == 0 while body blocks get sourceIndent > 0
    note_blk = by_text["NOTE: Verify magnification per Table 1-2."]
    assert note_blk.get("blockOutdent", 0) >= 1.2
    assert note_blk.get("sourceIndent") == 0
    assert ind_blk.get("sourceIndent", 0) > 0


def test_v423_rtl_horizontal_word_and_subword_coalescing_preserves_side_by_side_bubbles_and_columns():
    from comic_studio.ocr_grouping import organize_ocr_blocks

    # Shattered Persian sentence fragments on the same row in comic mode -> 1 unified RTL sentence with ZWNJ & sub-word glue,
    # while a second comic bubble far to the left on the same row stays a separate block!
    shattered_comic = [
        line(1, "چسبند؟", 310, 40, width=62, height=24),
        line(2, "نمی", 376, 40, width=34, height=24),
        line(3, "به هم", 418, 40, width=46, height=24),
        line(4, "رسی", 474, 40, width=36, height=24),
        line(5, "فا", 511, 40, width=20, height=24),
        line(6, "چرا حروف", 542, 40, width=78, height=24),
        # Separate bubble to the left (gap = 310 - 190 = 120px = 5.0 * height)
        line(7, "کلاه گشاد گرگ!", 60, 41, width=130, height=24),
    ]
    grouped_comic, mode = organize_ocr_blocks(shattered_comic, page_mode="comic", group_lines=True, page_size=(680, 300))
    assert mode == "comic"
    assert [b["text"] for b in grouped_comic] == [
        "چرا حروف فارسی به هم نمی\u200cچسبند؟",
        "کلاه گشاد گرگ!",
    ]
    assert len(grouped_comic[0]["sourceLines"]) == 6



