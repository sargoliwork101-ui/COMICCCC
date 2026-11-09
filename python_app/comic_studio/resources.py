"""User-defined CPU & RAM budget for Comic OCR Studio (v4.29).

Why this exists: on weaker computers the studio used every core and as much
memory as it could, which made the whole system (and the app itself) feel
frozen while a page was being recognized.  The user now decides, in the
in-app settings, how much of the machine the app may use.

The budget is a single small JSON file next to the other app settings, so it
survives restarts and follows the optional custom storage folder.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from .paths import data_dir

BUDGET_FILENAME = "resource-budget.json"

MODE_AUTO = "auto"
MODE_MANUAL = "manual"

MIN_PERCENT = 10
MAX_PERCENT = 100
DEFAULT_CPU_PERCENT = 60
DEFAULT_RAM_PERCENT = 60

# Memory that must stay free for Windows itself and the browser.
RAM_RESERVE_GB = 1.2

_LOCK = threading.RLock()
_CACHE: tuple[str, int, int, dict[str, Any]] | None = None


def budget_path() -> Path:
    """Location of the user's CPU/RAM budget (inside the active data folder)."""
    return data_dir() / BUDGET_FILENAME


def _clamp_percent(value: Any, fallback: int) -> int:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return fallback
    return max(MIN_PERCENT, min(MAX_PERCENT, number))


def _normalize(raw: Any) -> dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    mode = MODE_MANUAL if str(data.get("mode") or "").strip().lower() == MODE_MANUAL else MODE_AUTO
    cpu_raw = data.get("cpuPercent", data.get("cpu_percent"))
    ram_raw = data.get("ramPercent", data.get("ram_percent"))
    return {
        "mode": mode,
        "cpuPercent": _clamp_percent(cpu_raw, DEFAULT_CPU_PERCENT),
        "ramPercent": _clamp_percent(ram_raw, DEFAULT_RAM_PERCENT),
    }


def load_budget() -> dict[str, Any]:
    """Read the saved budget; falls back to the automatic mode when unavailable."""
    global _CACHE
    path = budget_path()
    try:
        stat = path.stat()
    except OSError:
        with _LOCK:
            _CACHE = None
        return _normalize({})
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    with _LOCK:
        if _CACHE is not None and _CACHE[:3] == key:
            return dict(_CACHE[3])
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        payload = {}
    normalized = _normalize(payload)
    with _LOCK:
        _CACHE = (key[0], key[1], key[2], normalized)
    return dict(normalized)


def save_budget(payload: Any) -> dict[str, Any]:
    """Persist the user's choice and return the normalized result."""
    normalized = _normalize(payload)
    path = budget_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)
    global _CACHE
    with _LOCK:
        _CACHE = None
    return normalized


def cpu_percent() -> int | None:
    """The user's CPU share, or ``None`` when the automatic mode is active."""
    budget = load_budget()
    if budget["mode"] != MODE_MANUAL:
        return None
    return int(budget["cpuPercent"])


def ram_percent() -> int | None:
    """The user's RAM share, or ``None`` when the automatic mode is active."""
    budget = load_budget()
    if budget["mode"] != MODE_MANUAL:
        return None
    return int(budget["ramPercent"])


def machine_profile() -> dict[str, Any]:
    """Best-effort description of the machine the app runs on."""
    cores = max(1, int(os.cpu_count() or 1))
    ram_gb = 0.0
    try:
        if os.name == "nt":  # pragma: no cover - Windows only
            import ctypes

            class _MemoryStatusEx(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = _MemoryStatusEx()
            status.dwLength = ctypes.sizeof(_MemoryStatusEx)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                ram_gb = float(status.ullTotalPhys) / (1024.0 * 1024.0 * 1024.0)
        else:
            page_size = os.sysconf("SC_PAGE_SIZE")
            total_pages = os.sysconf("SC_PHYS_PAGES")
            ram_gb = float(page_size * total_pages) / (1024.0 * 1024.0 * 1024.0)
    except Exception:
        ram_gb = 0.0
    return {"cpuCores": cores, "ramGb": round(ram_gb, 2)}


def effective_cpu_cores(total_cores: int | None = None) -> int:
    """How many CPU cores the app may use right now.

    In the automatic mode nothing changes (the app keeps its existing smart
    behaviour); in the manual mode the cores are scaled by the user's share.
    """
    cores = max(1, int(total_cores if total_cores is not None else (os.cpu_count() or 1)))
    share = cpu_percent()
    if share is None:
        return cores
    allowed = int(round(cores * share / 100.0))
    return max(1, min(cores, allowed))


def usable_ram_mb(total_ram_gb: float | None = None, *, reserve_gb: float = RAM_RESERVE_GB) -> float:
    """How much memory the app may use for parallel work, in megabytes."""
    total_gb = float(total_ram_gb if total_ram_gb is not None else machine_profile()["ramGb"])
    if total_gb <= 0:
        return 0.0
    free_gb = max(0.0, total_gb - max(0.0, reserve_gb))
    share = ram_percent()
    if share is None:
        return free_gb * 1024.0
    return free_gb * 1024.0 * (share / 100.0)


def budget_summary() -> dict[str, Any]:
    """A ready-to-show summary for the settings dialog."""
    budget = load_budget()
    profile = machine_profile()
    cores = int(profile["cpuCores"])
    ram_gb = float(profile["ramGb"])
    allowed_cores = effective_cpu_cores(cores)
    allowed_ram_mb = usable_ram_mb(ram_gb)
    return {
        **budget,
        "cpuCores": cores,
        "ramGb": ram_gb,
        "allowedCores": allowed_cores,
        "allowedRamMb": int(round(allowed_ram_mb)),
        "minPercent": MIN_PERCENT,
        "maxPercent": MAX_PERCENT,
    }
