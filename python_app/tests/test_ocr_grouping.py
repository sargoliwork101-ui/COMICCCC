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

