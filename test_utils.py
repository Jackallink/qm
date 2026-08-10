import pytest

from utils import chunk, dedupe, retry


def test_dedupe_removes_duplicates_preserving_order():
    assert dedupe([3, 1, 3, 2, 1]) == [3, 1, 2]


def test_dedupe_empty():
    assert dedupe([]) == []


def test_dedupe_keeps_single_occurrence_items():
    assert dedupe([1, 2, 3]) == [1, 2, 3]


def test_dedupe_strings():
    assert dedupe(["a", "b", "a", "c", "b"]) == ["a", "b", "c"]


def test_dedupe_does_not_mutate_input():
    items = [3, 1, 3, 2, 1]
    dedupe(items)
    assert items == [3, 1, 3, 2, 1]


def test_dedupe_unhashable_items_raise_type_error():
    with pytest.raises(TypeError):
        dedupe([[1], [1], [2]])


@pytest.mark.parametrize(
    "items,n,expected",
    [
        ([1, 2, 3, 4, 5], 2, [[1, 2], [3, 4], [5]]),
        ([1, 2, 3, 4], 2, [[1, 2], [3, 4]]),
        ([1, 2, 3], 1, [[1], [2], [3]]),
        ([1, 2, 3], 10, [[1, 2, 3]]),
        ([1, 2, 3, 4, 5], 3, [[1, 2, 3], [4, 5]]),
        ([], 3, []),
    ],
)
def test_chunk_splits_into_expected_pieces(items, n, expected):
    assert chunk(items, n) == expected


def test_chunk_accepts_any_sequence():
    assert chunk("abcdef", 4) == [["a", "b", "c", "d"], ["e", "f"]]


@pytest.mark.parametrize("n", [0, -1])
def test_chunk_rejects_non_positive_size(n):
    with pytest.raises(ValueError):
        chunk([1, 2], n)


def test_chunk_does_not_mutate_input():
    items = [1, 2, 3, 4, 5]
    chunk(items, 2)
    assert items == [1, 2, 3, 4, 5]


def test_retry_succeeds_on_first_attempt():
    assert retry(lambda: 42, 3) == 42


def test_retry_succeeds_after_failures():
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError("not yet")
        return "ok"

    assert retry(flaky, 5) == "ok"
    assert len(calls) == 3


def test_retry_stops_after_first_success():
    calls = []

    def succeed():
        calls.append(1)
        return "done"

    assert retry(succeed, 5) == "done"
    assert len(calls) == 1


def test_retry_exhausts_budget_and_reraises_last_error():
    calls = []

    def always_fail():
        calls.append(1)
        raise KeyError("boom")

    with pytest.raises(KeyError, match="boom"):
        retry(always_fail, 3)
    assert len(calls) == 3


@pytest.mark.parametrize("times", [0, -1])
def test_retry_rejects_non_positive_times(times):
    with pytest.raises(ValueError):
        retry(lambda: None, times)


def test_retry_does_not_catch_keyboard_interrupt():
    calls = []

    def interrupt():
        calls.append(1)
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        retry(interrupt, 3)
    assert len(calls) == 1
