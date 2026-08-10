"""Small, dependency-free helpers for lists and retrying.

All functions are pure Python and require no third-party packages.
"""

from collections.abc import Callable, Sequence
from typing import TypeVar

__all__ = ["dedupe", "chunk", "retry"]

T = TypeVar("T")
R = TypeVar("R")


def dedupe(items: Sequence[T]) -> list[T]:
    """Return a new list with duplicate items removed, preserving first-seen order.

    Items must be hashable (e.g. str, int, tuple). Unhashable items such as
    list or dict raise TypeError.

    Args:
        items: The sequence to deduplicate.

    Returns:
        A new list containing each distinct item in its original order.

    Example:
        >>> dedupe([3, 1, 3, 2, 1])
        [3, 1, 2]
    """
    seen: set[T] = set()
    result: list[T] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def chunk(items: Sequence[T], n: int) -> list[list[T]]:
    """Split a sequence into consecutive chunks of at most n items.

    The final chunk may be shorter than n. The original sequence is not
    modified.

    Args:
        items: The sequence to split.
        n: Maximum size of each chunk; must be a positive integer.

    Returns:
        A list of chunks, each a list of up to n items.

    Raises:
        ValueError: If n is not positive.

    Example:
        >>> chunk([1, 2, 3, 4, 5], 2)
        [[1, 2], [3, 4], [5]]
    """
    if n <= 0:
        raise ValueError(f"chunk size must be positive, got {n}")
    return [list(items[i : i + n]) for i in range(0, len(items), n)]


def retry(fn: Callable[[], R], times: int) -> R:
    """Call fn repeatedly until it succeeds or the attempt budget is exhausted.

    fn is invoked immediately for the first attempt; each failure is caught and
    retried until `times` attempts have been made in total.

    Args:
        fn: Zero-argument callable returning the desired result.
        times: Total number of attempts; must be a positive integer.

    Returns:
        The result of the first successful call to fn.

    Raises:
        ValueError: If times is not positive.
        Exception: The last exception raised by fn if every attempt fails.

    Example:
        >>> attempts = 0
        >>> def flaky():
        ...     global attempts
        ...     attempts += 1
        ...     if attempts < 3:
        ...         raise RuntimeError("not yet")
        ...     return "ok"
        >>> retry(flaky, 3)
        'ok'
    """
    if times <= 0:
        raise ValueError(f"times must be positive, got {times}")
    last_error: BaseException | None = None
    for _ in range(times):
        try:
            return fn()
        except Exception as exc:
            last_error = exc
    assert last_error is not None
    raise last_error
