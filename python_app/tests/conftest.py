from __future__ import annotations

import pytest

from comic_studio import _public_key, license_guard

_SESSION_SEED, _SESSION_PUB = license_guard.ed25519_generate_keypair()


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "unlicensed: start test without pre-activating an ephemeral Ed25519 license",
    )


@pytest.fixture(autouse=True)
def _ephemeral_signed_license_fixture(
    request: pytest.FixtureRequest,
    tmp_path_factory: pytest.TempPathFactory,
):
    """Provision an isolated license directory & real Ed25519-signed license per test.

    Uses a dedicated `MonkeyPatch()` instance and `tmp_path_factory` so:
    1. Production code contains ZERO environment-variable license bypasses.
    2. `monkeypatch.undo()` inside individual tests never undoes this fixture.
    3. `tmp_path` inside tests (`assert list(tmp_path.iterdir()) == [...]`) stays untouched.
    """
    lic_dir = tmp_path_factory.mktemp("cs4_lic")
    anchor_dir = lic_dir / "anchor"
    mp = pytest.MonkeyPatch()
    mp.setattr(_public_key, "PUBLIC_VERIFY_KEY_HEX", _SESSION_PUB.hex())
    mp.setattr(license_guard, "_LICENSE_DIR_OVERRIDE", lic_dir)
    mp.setattr(license_guard, "_SECONDARY_ANCHOR_OVERRIDE", anchor_dir)
    license_guard.SECURITY_GATE.reset_memory_state()

    if request.node.get_closest_marker("unlicensed") is None:
        hwid = license_guard.compute_hardware_id()
        token = license_guard.issue_license_token(
            private_seed_hex=_SESSION_SEED.hex(),
            hardware_id=hwid,
            holder="کاربر تست خودکار",
            plan="lifetime",
        )
        license_guard.SECURITY_GATE.activate_token(token)

    try:
        yield
    finally:
        license_guard.SECURITY_GATE.reset_memory_state()
        mp.undo()
