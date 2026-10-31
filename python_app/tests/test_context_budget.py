import json

import pytest

from comic_studio.context_budget import ContextBudget, build_context_request, parse_context_response
from comic_studio.translation import TranslationError


def test_default_percentages_are_independent_caps_and_actual_space_is_reused():
    budget = ContextBudget(1000)
    assert budget.skill_limit == 150
    assert budget.context_limit == 150
    empty = build_context_request(budget, 'English', '', '')
    partial = build_context_request(budget, 'English', 'a' * 10, 'b' * 20)
    full = build_context_request(budget, 'English', 'a' * 150, 'b' * 150)
    assert 'max 150 characters incl. spaces' in full.system
    assert 'count and shorten to fit' in full.system
    assert empty.source_capacity > partial.source_capacity > full.source_capacity
    assert full.character_count('x' * full.source_capacity) == 1000
    assert full.character_count('x') <= 1000
    with pytest.raises(TranslationError):
        full.user_message('x' * (full.source_capacity + 1))


def test_missing_summary_does_not_consume_its_budget():
    budget = ContextBudget(1000, context_percent=15, skill_percent=15)
    first = build_context_request(budget, 'English', 'راهنما', '')
    later = build_context_request(budget, 'English', 'راهنما', 'الف')
    assert first.source_capacity - later.source_capacity == len('Context: الف\n')


def test_existing_overlong_values_cause_errors_not_truncation():
    budget = ContextBudget(1000)
    with pytest.raises(TranslationError, match='راهنمای ترجمه'):
        build_context_request(budget, 'English', 'a' * 151, '')
    with pytest.raises(TranslationError, match='خلاصهٔ قبلی'):
        build_context_request(budget, 'English', '', 'b' * 151)
    with pytest.raises(TranslationError, match='یک خط'):
        build_context_request(budget, 'English', '', 'old\ncontext')
    with pytest.raises(TranslationError, match='فضایی'):
        build_context_request(ContextBudget(10), 'English', '', '')


def test_percentages_and_counts_use_unicode_codepoints_and_validate_input():
    budget = ContextBudget(1000, context_percent=20, skill_percent=5)
    assert (budget.context_limit, budget.skill_limit) == (200, 50)
    result = build_context_request(budget, 'English', 'ا' * 50, '🙂' * 200)
    assert result.character_count('سلام🙂') == len(result.system) + len(result.user_prefix + 'سلام🙂')
    with pytest.raises(TranslationError):
        build_context_request(budget, 'English', 'ا' * 51, '')
    with pytest.raises(ValueError):
        ContextBudget(1000, 80, 30)
    with pytest.raises(ValueError):
        ContextBudget(1000, True, 15)


def test_result_requires_both_fields_summary_cap_and_correct_line_mapping():
    good = json.dumps({'translation': 'اول\nدوم', 'summary': 'جان دوست مری است'}, ensure_ascii=False)
    assert parse_context_response(good, ['one', 'two'], 150) == ('اول\nدوم', 'جان دوست مری است')
    for data in ('not json', '{}', '{"translation":"ok","summary":1}',
                 json.dumps({'translation': 'first\nsecond', 'summary': 'x' * 151}),
                 json.dumps({'translation': 'first\nsecond', 'summary': 'first\nsecond'}),
                 json.dumps({'translation': 'only one line', 'summary': 'valid'})):
        with pytest.raises(TranslationError):
            parse_context_response(data, ['one', 'two'], 150)
