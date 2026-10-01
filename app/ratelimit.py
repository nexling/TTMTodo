from __future__ import annotations

import threading
import time


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_s: float) -> None:
        self.limit = limit
        self.window_s = window_s
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window_s
        with self._lock:
            hits = [stamp for stamp in self._hits.get(key, []) if stamp > cutoff]
            if len(hits) >= self.limit:
                self._hits[key] = hits
                if len(self._hits) > 8000:
                    self._prune(cutoff)
                return False
            hits.append(now)
            self._hits[key] = hits
            if len(self._hits) > 8000:
                self._prune(cutoff)
            return True

    def _prune(self, cutoff: float) -> None:
        stale = [key for key, hits in self._hits.items() if not hits or hits[-1] <= cutoff]
        for key in stale:
            self._hits.pop(key, None)


ics_feed_limiter = SlidingWindowLimiter(limit=60, window_s=60.0)
