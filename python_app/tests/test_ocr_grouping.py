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





def _long_book_column(rtl=False, x=60, start_id=1, count=32, step=40):
    text = ('این متن ادامهٔ یک پاراگراف بلند از کتاب است و باید پیوسته خوانده شود'
            if rtl else 'This is a continuing line of a long book paragraph with ordinary prose')
    return [line(start_id + i, f'{text} {i}', x, 80 + i * step, width=480, height=18)
            for i in range(count)]


def test_long_widely_spaced_book_paragraphs_join_in_both_directions():
    import copy
    from comic_studio.ocr_grouping import organize_ocr_blocks
    for rtl in (False, True):
        raw = _long_book_column(rtl)
        snapshot = copy.deepcopy(raw)
        for mode in ('document', 'auto'):
            result, effective = organize_ocr_blocks(raw, page_mode=mode, group_lines=True, page_size=(650, 1600))
            assert effective == 'document'
            assert len(result) == 1
            assert result[0]['text'] == ' '.join(b['text'] for b in raw)
            assert result[0]['sourceLines'] == raw
            assert result[0]['lineH'] == 18
        ungrouped, _ = organize_ocr_blocks(raw, page_mode='document', group_lines=False)
        assert len(ungrouped) == len(raw)
        assert raw == snapshot


def test_long_paragraph_gap_learning_stays_inside_columns_and_preserves_breaks():
    from comic_studio.ocr_grouping import organize_ocr_blocks
    for rtl in (False, True):
        right = _long_book_column(rtl, x=650, start_id=101, count=12, step=40)
        left = _long_book_column(rtl, x=60, count=12, step=24)
        # One actual paragraph break; should not be swallowed by the learned spacing.
        for b in right[6:]:
            b['y0'] += 55
            b['y1'] += 55
        raw = sorted(left + right, key=lambda b: b['y0'])
        result, _ = organize_ocr_blocks(raw, page_mode='document', page_size=(1250, 1000))
        expected = [right[:6], right[6:], left] if rtl else [left, right[:6], right[6:]]
        assert [b['text'] for b in result] == [' '.join(b['text'] for b in group) for group in expected]


def test_long_paragraphs_keep_new_indents_headings_and_list_items_separate():
    from comic_studio.ocr_grouping import organize_ocr_blocks
    for rtl in (False, True):
        raw = _long_book_column(rtl, count=20)
        # A new first-line indent at the normal cadence.
        if rtl:
            raw[8]['x1'] -= 32
        else:
            raw[8]['x0'] += 32
        raw[14]['text'] = '• مورد تازه' if rtl else '• A separate list item'
        raw[17]['pageRole'] = 'heading'
        result, _ = organize_ocr_blocks(raw, page_mode='document')
        texts = [b['text'] for b in result]
        assert texts[0] == ' '.join(b['text'] for b in raw[:8])
        assert texts[1] == ' '.join(b['text'] for b in raw[8:14])
        assert any(b['pageRole'] == 'list' and b['text'].startswith('•') for b in result)
        assert any(b['pageRole'] == 'heading' and b['text'] == raw[17]['text'] for b in result)


def test_sparse_distant_blocks_do_not_establish_paragraph_spacing():
    from comic_studio.ocr_grouping import group_document_lines
    raw = _long_book_column(count=3, step=40)
    assert len(group_document_lines(raw)) == 3
    far = _long_book_column(count=20, step=100)
    assert len(group_document_lines(far)) == 20


def test_chapter_reference_at_start_is_running_prose_not_heading():
    first = 'Chapter 1 explains switch-mode power supply techniques and types of converters, and it introduces'
    raw = [line(1, first, 44, 10, width=970, height=20),
           line(2, 'a few important results to help you better understand averaging techniques. This second edition includes', 14, 36, width=1000, height=20),
           line(3, 'the comprehensive derivation of root mean square current constraints of the basic switching cells,', 14, 62, width=1000, height=20),
           line(4, 'buck, boost, and buck-boost operated in continuous or discontinuous conduction modes.', 14, 88, width=1000, height=20)]
    blocks = group_ocr_lines(raw, page_mode='document', page_size=(1041, 582))
    assert len(blocks) == 1
    assert blocks[0]['pageRole'] == 'paragraph'
    assert blocks[0]['text'].startswith(first + ' a few')
    assert len(blocks[0]['sourceLines']) == 4


def test_real_chapter_title_stays_separate_from_body():
    raw = [line(1, 'Chapter 1 Power Supply Techniques', 40, 10, width=600, height=24),
           line(2, 'This chapter introduces several important design techniques', 14, 55, width=1000, height=20),
           line(3, 'and the following line continues the same ordinary paragraph.', 14, 81, width=1000, height=20)]
    blocks = group_ocr_lines(raw, page_mode='document', page_size=(1041, 582))
    assert len(blocks) == 2 and blocks[0]['pageRole'] == 'heading'


# Real line boxes taken from the reported book page (Basso, "Switch-Mode Power
# Supplies", 2nd ed., p. 5).  The first line is indented, the rest start at the
# column edge, and OCR misread the verb "explains" as "exp1ains".
_REPORTED_PAGE_BOXES = [
    (46, 10, 1015), (14, 36, 1017), (14, 62, 1016), (14, 88, 1014), (21, 114, 1013),
    (14, 140, 1016), (14, 166, 1014), (14, 192, 1015), (14, 218, 1014), (14, 244, 1016),
    (21, 270, 1013), (14, 296, 1015), (14, 322, 1014), (14, 348, 1015), (14, 374, 1014),
    (14, 400, 1016), (14, 426, 1014), (21, 452, 1015), (14, 478, 1016), (14, 504, 1013),
]


def _reported_page(first_text):
    texts = [first_text,
             'many different topologies that are used in modern power supplies. The first part of this chapter',
             'describes the basic buck converter and its operation in continuous conduction mode, then the',
             'boost and buck-boost converters are presented with their main waveforms and design equations.',
             'The average model of these converters is derived in the following sections so that the small',
             'signal transfer functions can be calculated for the control loop design. Special attention is',
             'paid to the effect of the equivalent series resistance of the output capacitor, because it',
             'introduces a zero in the transfer function of the converter that must be compensated',
             'properly in the feedback loop. The chapter ends with a short introduction to the isolated',
             'topologies such as the forward and flyback converters, which are widely used in low power',
             'applications. A complete design example is given at the end of the chapter to show how',
             'the theoretical results can be applied in practice, and the simulation of the complete',
             'converter is carried out with a circuit simulator to verify the analytical results that',
             'were derived in the previous sections of this chapter, including the losses in the',
             'switching devices and the magnetic components of the converter. The next chapter deals',
             'with the steady-state analysis of the converters in more detail and introduces the',
             'concept of the averaged switch model that is used throughout the book for the',
             'derivation of the small-signal models of the converters and their control loops',
             'in the frequency domain, and finally the experimental results are shown to',
             'validate the theoretical analysis presented in this chapter of the book']
    return [line(i + 1, text, x0, y0, width=x1 - x0, height=22)
            for i, ((x0, y0, x1), text) in enumerate(zip(_REPORTED_PAGE_BOXES, texts))]


def test_reported_page_keeps_indented_first_line_inside_the_paragraph():
    raw = _reported_page(
        'Chapter 1 explains switch-mode power supply techniques and types of converters, and it introduces')
    blocks = group_ocr_lines(raw, page_mode='document', page_size=(1041, 582))
    assert len(blocks) == 1
    assert blocks[0]['pageRole'] == 'paragraph'
    assert len(blocks[0]['sourceLines']) == 20
    assert blocks[0]['text'].startswith('Chapter 1 explains switch-mode')


def test_misread_prose_verb_after_chapter_number_does_not_become_a_heading():
    from comic_studio.ocr_grouping import _classify_document_line_role
    body = {'x0': 46, 'x1': 1015, 'y0': 10, 'y1': 32, 'lineH': 22}
    for text in (
        'Chapter 1 exp1ains switch-mode power supply techniques and types of converters, and it introduces',
        'Chapter 1 switch-mode power supply techniques and types of converters, and it introduces',
        'Chapter 4 descri bes how the generic switched models are derived from the converter topologies',
    ):
        assert _classify_document_line_role({**body, 'text': text}, 22.0, 1000.0) == 'paragraph'
    raw = _reported_page(
        'Chapter 1 exp1ains switch-mode power supply techniques and types of converters, and it introduces')
    blocks = group_ocr_lines(raw, page_mode='document', page_size=(1041, 582))
    assert len(blocks) == 1 and blocks[0]['pageRole'] == 'paragraph'


def test_real_titles_are_still_headings_after_prose_tolerance():
    from comic_studio.ocr_grouping import _classify_document_line_role
    body = {'x0': 40, 'x1': 700, 'y0': 10, 'y1': 34, 'lineH': 24}
    for text in ('Chapter 1 Power Supply Techniques',
                 'Chapter 3: Control Loop Design',
                 '2.4.1 Installation Requirements',
                 '2. Setup',
                 '1. Introduction to Modern Physics',
                 'III. RESULTS AND DISCUSSION'):
        assert _classify_document_line_role({**body, 'text': text}, 22.0, 1000.0) == 'heading', text


def test_sentence_ending_short_line_still_breaks_the_paragraph():
    # A line that really does end early (wide empty tail) and closes a sentence
    # starts a new paragraph.
    raw = [line(1, 'The converter operates in continuous conduction mode.', 14, 10, width=700),
           line(2, 'A new paragraph starts here and continues with more ordinary body text.', 14, 36, width=1000),
           line(3, 'and this line completes the second paragraph of the page nicely.', 14, 62, width=1000)]
    blocks = group_ocr_lines(raw, page_mode='document', page_size=(1041, 582))
    assert len(blocks) == 2
    assert blocks[0]['text'].endswith('conduction mode.')


def test_short_line_without_terminal_punctuation_keeps_the_paragraph_together():
    raw = [line(1, 'The converter operates in continuous conduction mode and the', 14, 10, width=700),
           line(2, 'next line continues the very same paragraph without any doubt.', 14, 36, width=1000),
           line(3, 'and this line completes the paragraph of the page nicely here.', 14, 62, width=1000)]
    blocks = group_ocr_lines(raw, page_mode='document', page_size=(1041, 582))
    assert len(blocks) == 1 and len(blocks[0]['sourceLines']) == 3


def test_numbered_list_entries_remain_list_items():
    from comic_studio.ocr_grouping import _classify_document_line_role
    body = {'x0': 30, 'x1': 400, 'y0': 10, 'y1': 32, 'lineH': 22}
    for text in ('1. First numbered list entry', '2. Second numbered entry with words'):
        assert _classify_document_line_role({**body, 'text': text}, 22.0, 1000.0) == 'list', text


def test_dropped_word_spaces_are_restored_in_an_all_caps_title():
    """Real engine output from the reported page: the title arrived as one glued run."""
    from comic_studio.ocr_grouping import restore_missing_word_spaces
    assert restore_missing_word_spaces('WHATYOUWILLFINDINTHEFOLLOWINGPAGES') == \
        'WHAT YOU WILL FIND IN THE FOLLOWING PAGES'
    assert restore_missing_word_spaces('POWERSUPPLYTECHNIQUES') == 'POWER SUPPLY TECHNIQUES'
    # Text that already has its spaces, real words, acronyms and camel-case names stay untouched.
    for text in ('This book thoroughly details the advantages of SPICE',
                 'GENERAL SOLDERING REQUIREMENTS', 'SNUBBER', 'MAXIM', 'CDE',
                 'MechanicalEngineering', 'ElectromagneticInterferenceFilterDesign'):
        assert restore_missing_word_spaces(text) == text, text


def test_section_number_box_joins_its_title_on_the_same_row():
    raw = [line(1, '1.2', 55, 69, width=37, height=22),
           line(2, 'WHAT YOU WILL FIND IN THE FOLLOWING PAGES', 111, 67, width=622, height=23),
           line(3, 'This book thoroughly details the advantages of SPICE to let you understand and simulate',
                147, 150, width=1000, height=18),
           line(4, 'power supply (SMPS) you want to design. By providing you with specific recipes',
                147, 176, width=1000, height=18)]
    blocks = group_ocr_lines(raw, page_mode='document', page_size=(1216, 278))
    assert [b['pageRole'] for b in blocks] == ['heading', 'paragraph']
    assert blocks[0]['text'] == '1.2 WHAT YOU WILL FIND IN THE FOLLOWING PAGES'


def test_reported_page_reads_as_numbered_title_and_body():
    """The exact base64-quality engine output of the reported page merges correctly."""
    raw = [line(1, '1.2', 55, 69, width=37, height=22),
           line(2, 'WHATYOUWILLFINDINTHEFOLLOWINGPAGES', 111, 67, width=622, height=23),
           line(3, 'ThisbookthoroughlydetailstheadvantagesofSPlCEtoletyouunderstand,simulate', 147, 150,
                width=1000, height=18),
           line(4, 'powersupply(SMPS)youwanttodesign.Byprovidingyouwithspecificrecipes', 147, 176,
                width=1000, height=18)]
    blocks = group_ocr_lines(raw, page_mode='document', page_size=(1216, 278))
    assert blocks[0]['pageRole'] == 'heading'
    assert blocks[0]['text'] == '1.2 WHAT YOU WILL FIND IN THE FOLLOWING PAGES'
    assert len(blocks) == 2


def test_rtl_section_number_joins_its_title_in_persian_order():
    raw = [line(1, '۲-۴', 1000, 69, width=60, height=22),
           line(2, 'روش‌های طراحی مدار کنترل', 111, 67, width=869, height=23),
           line(3, 'این کتاب روش‌های طراحی مبدل را با جزئیات کامل توضیح می‌دهد و مثال عملی دارد',
                147, 150, width=1000, height=18)]
    blocks = group_ocr_lines(raw, page_mode='document', page_size=(1216, 278))
    # In Persian books the section number is written first: «۲-۴ عنوان».
    assert blocks[0]['text'] == '۲-۴ روش‌های طراحی مدار کنترل'
    assert blocks[0]['pageRole'] == 'heading'


def test_tiny_ui_badges_do_not_turn_body_lines_into_headings():
    """A screenshot with small interface labels must still read as title + paragraph."""
    raw = [line(1, '1.2 WHAT YOU WILL FIND IN THE FOLLOWING PAGES', 111, 67, width=622, height=23),
           line(2, 'EN', 178, 114, width=19, height=14),
           line(3, 'ThisbookthoroughlydetailstheadvantagesofSPlCEtoletyouunderstand,simulatetest', 147, 150,
                width=960, height=18),
           line(4, 'ThisbookthoroughlydetailstheadvantagesofSPlCEtoletyouunderstand,simulatetest', 147, 176,
                width=960, height=19),
           line(5, 'EN', 179, 247, width=17, height=11),
           line(6, '3', 1108, 252, width=7, height=6)]
    blocks = group_ocr_lines(raw, page_mode='document', page_size=(1216, 278))
    roles = [b['pageRole'] for b in blocks if len(b['text']) > 20]
    assert roles[0] == 'heading', roles
    assert set(roles[1:]) == {'paragraph'}, roles


def test_glued_long_line_is_not_a_short_title():
    from comic_studio.ocr_grouping import _classify_document_line_role
    body = {'x0': 147, 'x1': 1144, 'y0': 150, 'y1': 169, 'lineH': 19}
    for text in (
        'ThisbookthoroughlydetailstheadvantagesofSPlCEtoletyouunderstand,simulate,test,andfinallyimprovethes',
        'powersupply(SMPS)youwanttodesign.Byprovidingyouwithspecificsimulationrecipes,thisworkintends',
        'possibleyourSMPSdesign.Unlikeotherbooks,theauthorstrivestobalancethetheoreticalcontent,necessary',
    ):
        assert _classify_document_line_role({**body, 'text': text}, 19.0, 1000.0) == 'paragraph', text


def test_persian_numbered_headings_are_recognised():
    from comic_studio.ocr_grouping import _classify_document_line_role
    box = {'x0': 111, 'x1': 980, 'y0': 67, 'y1': 90, 'lineH': 23}
    for text in ('۲-۴ روش‌های طراحی مدار کنترل', '۴. نتیجه‌گیری', '۱- مقدمه', '1.2 عنوان بخش'):
        assert _classify_document_line_role({**box, 'text': text}, 20.0, 1000.0) == 'heading', text


def test_glued_section_number_gets_its_space_back():
    from comic_studio.ocr_grouping import _split_leading_section_number
    assert _split_leading_section_number('1.2WHATYOUWILLFINDINTHEFOLLOWINGPAGES') == \
        '1.2 WHATYOUWILLFINDINTHEFOLLOWINGPAGES'
    assert _split_leading_section_number('2.4.1Installation Requirements') == '2.4.1 Installation Requirements'
    # Ordinary prose and already correct titles must not be touched.
    for text in ('1.2 WHAT YOU WILL FIND', '2020 was a long year', '3 apples and 4 oranges',
                 'III. RESULTS AND DISCUSSION', '4. نتیجه‌گیری'):
        assert _split_leading_section_number(text) == text, text


def test_glued_number_and_title_read_as_one_numbered_heading():
    source = [line(1, '1.2WHATYOUWILLFINDINTHEFOLLOWINGPAGES', 60, 12, width=640, height=24),
              line(2, 'This book thoroughly details the advantages of SPICE to let you understand, '
                      'simulate, test, and finally improve the switch-mode', 60, 60, width=980, height=18)]
    result = group_ocr_lines(source, page_mode='document')
    assert result[0]['text'] == '1.2 WHATYOUWILLFINDINTHEFOLLOWINGPAGES'
