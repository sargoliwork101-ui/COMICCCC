from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
from PIL import Image, ImageDraw
from support_client import scoped_client

from comic_studio import _public_key, license_guard
from comic_studio.exporter import build_docx, build_images_zip, build_pdf, build_pptx, build_txt
from comic_studio.license_guard import (
    CLOCK_DRIFT_TOLERANCE_SEC,
    LicenseError,
    SECURITY_GATE,
    compute_hardware_id,
    ed25519_generate_keypair,
    ed25519_public_key,
    ed25519_sign,
    ed25519_verify,
    issue_license_token,
    normalize_hardware_id,
    verify_license_token,
)
from comic_studio.main import create_app
from comic_studio.ocr import recognize_image
from comic_studio.store import ProjectStore
from comic_studio.translation import TranslationService


def _sample_png() -> bytes:
    img = Image.new("RGB", (240, 140), "white")
    ImageDraw.Draw(img).text((12, 12), "HELLO COMIC", fill="black")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def test_ed25519_rfc8032_official_vectors_and_malleability_rejection():
    # Official RFC 8032 §7.1 Test Vector 1 (empty message)
    seed1 = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    pub1 = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    sig1 = bytes.fromhex(
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e0652249015"
        "55fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
    )
    assert ed25519_public_key(seed1) == pub1
    assert ed25519_sign(seed1, b"") == sig1
    assert ed25519_verify(pub1, b"", sig1) is True
    assert ed25519_verify(pub1, b"x", sig1) is False

    # Official RFC 8032 §7.1 Test Vector 2 (1-byte 0x72)
    seed2 = bytes.fromhex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
    pub2 = bytes.fromhex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")
    sig2 = bytes.fromhex(
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69d"
        "a085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
    )
    assert ed25519_public_key(seed2) == pub2
    assert ed25519_sign(seed2, b"\x72") == sig2
    assert ed25519_verify(pub2, b"\x72", sig2) is True

    # Reject non-canonical malleable S + L >= L
    s_int = int.from_bytes(sig2[32:], "little")
    malleable_s = s_int + license_guard._L
    if malleable_s < (1 << 256):
        malleable_sig = sig2[:32] + malleable_s.to_bytes(32, "little")
        assert ed25519_verify(pub2, b"\x72", malleable_sig) is False

    # Reject identity / low-order public key (0, 1) -> 0x01 followed by 31 zero bytes
    identity_pub = b"\x01" + (b"\x00" * 31)
    assert ed25519_verify(identity_pub, b"", b"\x01" + (b"\x00" * 63)) is False


def test_hardware_id_and_signed_token_validation():
    hwid = compute_hardware_id(refresh=True)
    assert hwid.startswith("CS4-") and len(hwid) == 23
    # Case-insensitive and separator-tolerant normalization
    messy = "  " + hwid.lower().replace("-", " ") + "\u200c "
    assert normalize_hardware_id(messy) == hwid

    with pytest.raises(LicenseError) as bad_hwid:
        normalize_hardware_id("CS4-0000-1111-OOOO-IIII")  # ambiguous chars excluded
    assert bad_hwid.value.code == "INVALID_HARDWARE_ID"

    seed, pub = ed25519_generate_keypair()
    other_seed, _ = ed25519_generate_keypair()

    # Valid lifetime token (even with RTL directional marks pasted from Telegram/WhatsApp)
    tok = issue_license_token(
        private_seed_hex=seed.hex(),
        hardware_id=hwid,
        holder="مشتری وفادار",
        plan="lifetime",
    )
    pasted = f"\u200f  {tok[:20]}\n{tok[20:]} \u200c"
    info = verify_license_token(pasted, expected_hardware_id=hwid, public_key_bytes=pub)
    assert info["valid"] is True
    assert info["holder"] == "مشتری وفادار"
    assert info["plan"] == "lifetime"
    assert info["expiresAt"] is None

    # Signed with wrong seller private key -> rejected
    forged = issue_license_token(
        private_seed_hex=other_seed.hex(),
        hardware_id=hwid,
        holder="هکر",
        plan="lifetime",
    )
    with pytest.raises(LicenseError) as bad_sig:
        verify_license_token(forged, expected_hardware_id=hwid, public_key_bytes=pub)
    assert bad_sig.value.code == "INVALID_SIGNATURE"

    # Signed for a different customer's PC -> rejected on this PC
    other_pc = "CS4-ABCD-EFGH-JKLM-NPQR"
    if other_pc == hwid:
        other_pc = "CS4-2345-6789-ABCD-EFGH"
    wrong_pc_tok = issue_license_token(
        private_seed_hex=seed.hex(),
        hardware_id=other_pc,
        holder="سیستم دیگر",
        plan="lifetime",
    )
    with pytest.raises(LicenseError) as bad_pc:
        verify_license_token(wrong_pc_tok, expected_hardware_id=hwid, public_key_bytes=pub)
    assert bad_pc.value.code == "HARDWARE_MISMATCH"


@pytest.mark.unlicensed
def test_timed_license_expiry_and_anti_clock_rollback(monkeypatch):
    seed, pub = ed25519_generate_keypair()
    monkeypatch.setattr(_public_key, "PUBLIC_VERIFY_KEY_HEX", pub.hex())
    SECURITY_GATE.reset_memory_state()

    hwid = compute_hardware_id()
    t0 = 1_800_000_000
    sub_token = issue_license_token(
        private_seed_hex=seed.hex(),
        hardware_id=hwid,
        holder="اشتراک ماهانه",
        plan="subscription",
        days=30,
        issued_at=t0,
    )

    st_active, session_tok = SECURITY_GATE.activate_token(sub_token, now_ts=t0 + 3600)
    assert st_active["licensed"] is True
    assert st_active["unlocked"] is True
    assert st_active["license"]["daysRemaining"] == 30

    # Advance 5 days normally
    t_day5 = t0 + 5 * 86400
    st_day5 = SECURITY_GATE.inspect_status(session_token=session_tok, now_ts=t_day5)
    assert st_day5["licensed"] is True
    assert st_day5["license"]["daysRemaining"] == 25

    # Minor NTP adjustment (3 minutes backward <= 10 min tolerance) does NOT false-lock
    st_ntp = SECURITY_GATE.inspect_status(session_token=session_tok, now_ts=t_day5 - 180)
    assert st_ntp["licensed"] is True

    # Deliberate Windows clock rollback (2 days backward > CLOCK_DRIFT_TOLERANCE_SEC) -> BLOCKED!
    t_rolled_back = t_day5 - 2 * 86400
    assert t_day5 - t_rolled_back > CLOCK_DRIFT_TOLERANCE_SEC
    st_rollback = SECURITY_GATE.inspect_status(session_token=session_tok, now_ts=t_rolled_back)
    assert st_rollback["licensed"] is False
    assert st_rollback["reason"] == "clock_tampered"
    assert "ساعت" in st_rollback["message"]

    # Even if user tries to edit max_seen_utc inside primary license-state.json -> HMAC detects tampering!
    state_file = SECURITY_GATE._state_path()
    raw_state = json.loads(state_file.read_text(encoding="utf-8"))
    tampered = dict(raw_state, max_seen_utc=t0)
    state_file.write_text(json.dumps(tampered), encoding="utf-8")
    SECURITY_GATE.reset_memory_state()
    st_tampered = SECURITY_GATE.inspect_status(now_ts=t_rolled_back)
    assert st_tampered["licensed"] is False
    assert st_tampered["reason"] == "tampered"

    # Restore untampered file, restore real clock -> immediately works again!
    state_file.write_text(json.dumps(raw_state), encoding="utf-8")
    SECURITY_GATE.reset_memory_state()
    st_restored = SECURITY_GATE.inspect_status(now_ts=t_day5 + 60)
    assert st_restored["licensed"] is True

    # Past 30 days -> expired cleanly!
    st_expired = SECURITY_GATE.inspect_status(now_ts=t0 + 31 * 86400)
    assert st_expired["licensed"] is False
    assert st_expired["reason"] == "license_expired"


@pytest.mark.unlicensed
def test_middleware_api_block_engine_deep_guards_and_local_password_flow(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path / "data"))
    seed, pub = ed25519_generate_keypair()
    monkeypatch.setattr(_public_key, "PUBLIC_VERIFY_KEY_HEX", pub.hex())
    SECURITY_GATE.reset_memory_state()

    # 1. Deep engine guards independently reject unlicensed execution even outside HTTP!
    store = ProjectStore()
    proj = store.create("تست عمیق")
    proj_state = store.import_files(proj["id"], [("p.png", _sample_png())])
    img_item = proj_state["images"][0]
    with Image.open(io.BytesIO(_sample_png())) as pil_im:
        with pytest.raises(LicenseError):
            recognize_image(None, pil_im, "eng")
    with pytest.raises(LicenseError):
        TranslationService().translate("Hello", "eng")
    for export_fn in (build_pdf, build_images_zip, build_txt, build_docx, build_pptx):
        with pytest.raises(LicenseError):
            export_fn(store, proj_state, {"image_ids": [img_item["id"]]})

    # 2. HTTP middleware blocks workspace APIs with 402 while keeping shell, health & session alive
    with scoped_client(create_app()) as client:
        assert client.get("/").status_code == 200
        assert client.get("/style.css").status_code == 200
        assert client.get("/api/health").status_code == 200
        assert client.post("/api/session/heartbeat", json={"client_id": "tab-12345678"}).status_code == 200

        st0 = client.get("/api/license/status").json()
        assert st0["licensed"] is False
        assert st0["hardwareId"].startswith("CS4-")

        for blocked_route in ("/api/projects", "/api/engines", "/api/ai-settings", "/api/activity", "/api/storage-settings"):
            res = client.get(blocked_route)
            assert res.status_code == 402, (blocked_route, res.text)

        # 3. Activate real signed license -> workspace APIs immediately unlock!
        valid_key = issue_license_token(
            private_seed_hex=seed.hex(),
            hardware_id=st0["hardwareId"],
            holder="سارا احمدی",
            plan="lifetime",
        )
        act_res = client.post("/api/license/activate", json={"license_key": valid_key})
        assert act_res.status_code == 200
        assert act_res.json()["licensed"] is True
        assert act_res.json()["unlocked"] is True
        assert client.get("/api/projects").status_code == 200

        # 4. Set local login password (weak <4 rejected; valid accepted)
        weak = client.put("/api/license/password", json={"current_password": "", "new_password": "123"})
        assert weak.status_code == 400
        set_pwd = client.put("/api/license/password", json={"current_password": "", "new_password": "MySecret#2026"})
        assert set_pwd.status_code == 200
        assert set_pwd.json()["passwordEnabled"] is True
        assert set_pwd.json()["unlocked"] is True

        # 5. Lock/Logout -> /api/projects returns 401 LOGIN_REQUIRED!
        out_res = client.post("/api/license/logout")
        assert out_res.status_code == 200
        assert out_res.json()["licensed"] is True
        assert out_res.json()["unlocked"] is False
        assert client.get("/api/projects").status_code == 401

        # 6. Wrong password x5 triggers 429 rate-limit protection
        for _ in range(5):
            bad_login = client.post("/api/license/login", json={"password": "wrong-pass"})
            assert bad_login.status_code == 401
        rate_limited = client.post("/api/license/login", json={"password": "MySecret#2026"})
        assert rate_limited.status_code == 429
        SECURITY_GATE._failed_attempts.clear()

        # 7. Correct password logs in cleanly
        ok_login = client.post("/api/license/login", json={"password": "MySecret#2026"})
        assert ok_login.status_code == 200
        assert ok_login.json()["unlocked"] is True
        assert client.get("/api/projects").status_code == 200

        # 8. Forgotten local password recovery using original signed CLIC1. license key
        client.post("/api/license/logout")
        assert client.get("/api/projects").status_code == 401
        recover = client.post(
            "/api/license/activate",
            json={"license_key": valid_key, "reset_local_password": True},
        )
        assert recover.status_code == 200
        assert recover.json()["passwordEnabled"] is False
        assert recover.json()["unlocked"] is True
        assert client.get("/api/projects").status_code == 200


def test_seller_vault_key_sync_issuance_backup_and_dist_leak_guard(tmp_path):
    import sys

    py_root = Path(__file__).resolve().parents[1]
    if str(py_root) not in sys.path:
        sys.path.insert(0, str(py_root))
    from license_manager import SellerVault
    from offline_packaging.build_offline_package import verify_no_seller_secrets_in_dist

    fake_pub_py = tmp_path / "_public_key.py"
    fake_pub_py.write_text(
        'PUBLIC_VERIFY_KEY_HEX: str = (\n    "0000000000000000000000000000000000000000000000000000000000000000"\n)\n',
        encoding="utf-8",
    )
    seller_dir = tmp_path / "seller_private_vault"
    vault = SellerVault(seller_dir=seller_dir, public_key_py=fake_pub_py)
    key_info = vault.ensure_master_key(sync_source=True)
    assert len(key_info["public_key_hex"]) == 64
    assert key_info["public_key_hex"] in fake_pub_py.read_text(encoding="utf-8")
    assert key_info["private_seed_hex"] not in fake_pub_py.read_text(encoding="utf-8")

    # Issue a 90-day customer license and verify against synced public key
    cust_hwid = "CS4-ABCD-EFGH-JKLM-NPQR"
    issued = vault.issue(hardware_id=cust_hwid, holder="خریدار شماره ۱", plan="subscription", days=90)
    parsed = verify_license_token(
        issued["token"],
        expected_hardware_id=cust_hwid,
        public_key_bytes=bytes.fromhex(key_info["public_key_hex"]),
    )
    assert parsed["holder"] == "خریدار شماره ۱"
    assert parsed["daysTotal"] == 90
    assert len(vault.list_history()) == 1

    # Backup & restore into a fresh vault preserves exact public/private keypair
    vault2 = SellerVault(seller_dir=tmp_path / "restored_vault", public_key_py=fake_pub_py)
    restored = vault2.import_master_key(key_info, sync_source=True)
    assert restored["public_key_hex"] == key_info["public_key_hex"]

    # Dist bundle leak guard catches any accidental seller file in dist/
    clean_dist = tmp_path / "dist" / "ComicOCRStudio"
    clean_dist.mkdir(parents=True)
    (clean_dist / "ComicOCRStudio.exe").write_bytes(b"MZ")
    verify_no_seller_secrets_in_dist(clean_dist)

    (clean_dist / "seller_master_key.json").write_text("{}", encoding="utf-8")
    with pytest.raises(RuntimeError, match="SECURITY ABORT"):
        verify_no_seller_secrets_in_dist(clean_dist)
