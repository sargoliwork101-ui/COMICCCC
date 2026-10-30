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
