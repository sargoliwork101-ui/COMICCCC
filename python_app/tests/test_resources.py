from __future__ import annotations

import os

from starlette.testclient import TestClient

from comic_studio import resources
from comic_studio.main import create_app
from comic_studio.ocr_managed import compute_worker_count, cpu_core_count


def _client() -> TestClient:
    return TestClient(create_app(), base_url="http://127.0.0.1:8765", client=("127.0.0.1", 50000))


def test_v429_resource_budget_limits_cpu_and_ram_and_survives_a_restart(tmp_path, monkeypatch):
    """v4.29: the user decides how much of the machine the studio may use."""
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    resources._CACHE = None

    # Automatic mode keeps the existing behaviour (nothing is limited yet).
    summary = resources.budget_summary()
    assert summary["mode"] == "auto"
    assert summary["allowedCores"] == summary["cpuCores"]
    assert cpu_core_count() == max(1, int(os.cpu_count() or 1))

    with _client() as client:
        response = client.get("/api/resources")
        assert response.status_code == 200
        assert response.json()["mode"] == "auto"

        saved = client.put("/api/resources", json={"mode": "manual", "cpuPercent": 25, "ramPercent": 40})
        assert saved.status_code == 200
        body = saved.json()
        assert body["mode"] == "manual"
        assert body["cpuPercent"] == 25
        assert body["ramPercent"] == 40

    # The saved choice is used by the engines right away (no restart needed).
    total_cores = max(1, int(os.cpu_count() or 1))
    allowed = resources.effective_cpu_cores(total_cores)
    assert allowed == max(1, min(total_cores, round(total_cores * 0.25)))
    assert cpu_core_count() == allowed

    # And it is still there after a restart (a fresh process reads the same file).
    resources._CACHE = None
    reloaded = resources.load_budget()
    assert reloaded["mode"] == "manual"
    assert reloaded["cpuPercent"] == 25
    assert reloaded["ramPercent"] == 40


def test_v429_manual_budget_caps_the_number_of_parallel_workers(tmp_path, monkeypatch):
    """A small RAM share must reduce how many pages are processed at the same time."""
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    resources._CACHE = None
    monkeypatch.setenv("COMIC_STUDIO_FAKE_HARDWARE_JSON", '{"cpuCores": 8, "ramGb": 8}')

    resources.save_budget({"mode": "manual", "cpuPercent": 50, "ramPercent": 25})
    try:
        assert cpu_core_count() == 4
        workers, threads = compute_worker_count(8, per_worker_mb=180, max_cap=8)
        # 8 GB RAM - 1.2 GB reserve = 6.8 GB; 25 % of that -> ~1.7 GB -> 9 pages of 180 MB
        # but only 4 cores are allowed, so at most 4 pages run at the same time.
        assert workers <= 4
        assert threads >= 1
        assert workers * threads <= 4
    finally:
        resources._CACHE = None


def test_v429_budget_values_are_clamped_to_sane_limits(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    resources._CACHE = None
    saved = resources.save_budget({"mode": "manual", "cpuPercent": 5, "ramPercent": 500})
    assert saved["cpuPercent"] == resources.MIN_PERCENT
    assert saved["ramPercent"] == resources.MAX_PERCENT
    # An unknown/garbage file must never break the app.
    resources.budget_path().write_text("not json", encoding="utf-8")
    resources._CACHE = None
    assert resources.load_budget()["mode"] == "auto"
