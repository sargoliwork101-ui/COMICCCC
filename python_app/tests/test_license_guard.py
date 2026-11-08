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
    monkeypatch.setattr(license_guard, "_AUTO_TRIAL_ENABLED", False)
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


@pytest.mark.unlicensed
def test_auto_24h_trial_banner_anti_reset_clock_rollback_and_expiry(tmp_path, monkeypatch):
    """v4.16: Fresh install grants a 24h trial with 09361111111 notice, resists file deletion, and locks after 24h."""
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path / "data"))
    assert license_guard._AUTO_TRIAL_ENABLED is True
    seed, pub = ed25519_generate_keypair()
    monkeypatch.setattr(_public_key, "PUBLIC_VERIFY_KEY_HEX", pub.hex())
    SECURITY_GATE.reset_memory_state()

    t0 = 1_810_000_000
    st0 = SECURITY_GATE.inspect_status(now_ts=t0)
    assert st0["licensed"] is True
    assert st0["unlocked"] is True
    assert st0["isTrial"] is True
    assert st0["supportPhone"] == "09361111111"
    assert "09361111111" in st0["message"]
    assert st0["trialRemainingSeconds"] == 86_400
    for mod_id in ("ocr", "translation", "editing"):
        assert st0["modules"][mod_id]["active"] is True
        assert st0["modules"][mod_id]["source"] == "trial"

    # Advance 10 hours, then DELETE primary license-state.json -> secondary anchor prevents trial reset!
    t_10h = t0 + 10 * 3600
    st_10h = SECURITY_GATE.inspect_status(now_ts=t_10h)
    assert st_10h["trialRemainingSeconds"] == 14 * 3600
    SECURITY_GATE._state_path().unlink()
    SECURITY_GATE.reset_memory_state()

    st_after_delete = SECURITY_GATE.inspect_status(now_ts=t_10h + 60)
    assert st_after_delete["isTrial"] is True
    assert st_after_delete["trialRemainingSeconds"] == 14 * 3600 - 60  # NOT reset back to 86400!

    # Rolling Windows clock backward by 3 hours during trial -> locked (`clock_tampered`)
    st_rollback = SECURITY_GATE.inspect_status(now_ts=t_10h - 3 * 3600)
    assert st_rollback["licensed"] is False
    assert st_rollback["reason"] == "clock_tampered"

    # Past 24 hours -> trial expires and blocks API with HTTP 402 + 09361111111
    t_expired = t0 + 86_401
    st_exp = SECURITY_GATE.inspect_status(now_ts=t_expired)
    assert st_exp["licensed"] is False
    assert st_exp["reason"] == "trial_expired"
    assert "09361111111" in st_exp["message"]

    # Even deleting license-state.json AFTER 24h expiry STILL stays expired!
    SECURITY_GATE._state_path().unlink()
    SECURITY_GATE.reset_memory_state()
    st_exp_again = SECURITY_GATE.inspect_status(now_ts=t_expired + 10)
    assert st_exp_again["licensed"] is False
    assert st_exp_again["reason"] == "trial_expired"


@pytest.mark.unlicensed
def test_modular_three_part_licensing_durations_cumulative_and_route_gates(tmp_path, monkeypatch):
    """v4.16: OCR, Translation & Editing activate independently with custom durations & cumulative keys."""
    import sys

    py_root = Path(__file__).resolve().parents[1]
    if str(py_root) not in sys.path:
        sys.path.insert(0, str(py_root))
    from license_manager import SellerVault, parse_modules_cli_spec

    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path / "data"))
    fake_pub_py = tmp_path / "_pub.py"
    fake_pub_py.write_text(
        f'PUBLIC_VERIFY_KEY_HEX: str = (\n    "{_public_key.PUBLIC_VERIFY_KEY_HEX}"\n)\n',
        encoding="utf-8",
    )
    vault = SellerVault(seller_dir=tmp_path / "seller", public_key_py=fake_pub_py)
    key_rec = vault.ensure_master_key(sync_source=True)
    monkeypatch.setattr(_public_key, "PUBLIC_VERIFY_KEY_HEX", key_rec["public_key_hex"])
    SECURITY_GATE.reset_memory_state()

    import time as _time

    hwid = compute_hardware_id()
    t0 = int(_time.time()) - 120

    # Key 1 via CLI spec: OCR = lifetime, Translation = 15 days, Editing = off
    spec1 = parse_modules_cli_spec("ocr=lifetime,translation=15,editing=off")
    tok1 = issue_license_token(
        private_seed_hex=key_rec["private_seed_hex"],
        hardware_id=hwid,
        holder="خریدار ماژولار",
        issued_at=t0,
        modules=spec1,
    )

    with scoped_client(create_app()) as client:
        act1 = client.post("/api/license/activate", json={"license_key": tok1})
        assert act1.status_code == 200
        body1 = act1.json()
        assert body1["licensed"] is True
        assert body1["isTrial"] is False  # Paid key immediately replaces 24h trial
        assert body1["modules"]["ocr"]["active"] is True
        assert body1["modules"]["ocr"]["plan"] == "lifetime"
        assert body1["modules"]["translation"]["active"] is True
        assert body1["modules"]["translation"]["daysRemaining"] == 15
        assert body1["modules"]["editing"]["active"] is False

        # Base workspace + file import + non-editing state save + rendered upload + export ALL succeed!
        proj = client.post("/api/projects", json={"name": "پروژه ماژولار"}).json()
        pid = proj["id"]
        imported = client.post(
            f"/api/projects/{pid}/files",
            files=[("files", ("page1.png", _sample_png(), "image/png"))],
        )
        assert imported.status_code == 200
        proj_data = imported.json()
        img_id = proj_data["images"][0]["id"]

        # Changing project name & selection (non-editing state) succeeds even with editing=False!
        proj_data["name"] = "تغییر نام مجاز"
        proj_data["images"][0]["selected"] = True
        non_edit_save = client.put(f"/api/projects/{pid}/state", json={"state": proj_data})
        assert non_edit_save.status_code == 200

        # Rendered bubble upload + revert + TXT export succeed for OCR/Translation buyer!
        rend = client.post(
            f"/api/projects/{pid}/images/{img_id}/rendered",
            content=_sample_png(),
            headers={"Content-Type": "image/png"},
        )
        assert rend.status_code == 200
        rev = client.post(f"/api/projects/{pid}/images/{img_id}/revert")
        assert rev.status_code == 200
        exp = client.post(f"/api/projects/{pid}/export", json={"kind": "txt", "image_ids": [img_id]})
        assert exp.status_code == 200

        # Editing mutations (`blocks`, `crop`, `watermark`, `/duplicate`) are BLOCKED with 402 + 09361111111!
        edit_attempt = json.loads(json.dumps(non_edit_save.json()))
        edit_attempt["images"][0]["blocks"] = [{"id": "b1", "text": "manual", "x0": 0, "y0": 0, "x1": 10, "y1": 10}]
        blocked_edit = client.put(f"/api/projects/{pid}/state", json={"state": edit_attempt})
        assert blocked_edit.status_code == 402
        assert blocked_edit.json()["code"] == "MODULE_EDITING_REQUIRED"
        assert "09361111111" in blocked_edit.json()["detail"]

        blocked_dup = client.post(f"/api/projects/{pid}/duplicate", json=[img_id])
        assert blocked_dup.status_code == 402
        assert blocked_dup.json()["code"] == "MODULE_EDITING_REQUIRED"

        # Now customer buys Editing (60 days) -> cumulative activation keeps OCR + Translation AND adds Editing!
        issued_edit = vault.issue(
            hardware_id=hwid,
            holder="خریدار ماژولار",
            modules={"editing": {"plan": "subscription", "days": 60}},
        )
        act2 = client.post("/api/license/activate", json={"license_key": issued_edit["token"]})
        assert act2.status_code == 200
        body2 = act2.json()
        assert body2["modules"]["ocr"]["active"] is True
        assert body2["modules"]["translation"]["active"] is True
        assert body2["modules"]["editing"]["active"] is True
        assert body2["modules"]["editing"]["daysRemaining"] == 60

        # Editing state save & duplicate now succeed!
        ok_edit = client.put(f"/api/projects/{pid}/state", json={"state": edit_attempt})
        assert ok_edit.status_code == 200
        assert client.post(f"/api/projects/{pid}/duplicate", json=[img_id]).status_code == 200

        # Replace with Editing-only key -> OCR & Translation routes return 402 MODULE_OCR/TRANSLATION_REQUIRED!
        only_edit_tok = issue_license_token(
            private_seed_hex=key_rec["private_seed_hex"],
            hardware_id=hwid,
            holder="فقط ویرایش",
            issued_at=t0,
            modules={"editing": {"plan": "lifetime"}},
        )
        act3 = client.post(
            "/api/license/activate",
            json={"license_key": only_edit_tok, "replace_all_modules": True},
        )
        assert act3.status_code == 200
        assert act3.json()["modules"]["ocr"]["active"] is False
        assert act3.json()["modules"]["translation"]["active"] is False
        assert act3.json()["modules"]["editing"]["active"] is True

        ocr_blocked = client.post(
            f"/api/projects/{pid}/ocr",
            json={"engine": "tesseract", "language": "eng", "image_ids": [img_id]},
        )
        assert ocr_blocked.status_code == 402
        assert ocr_blocked.json()["code"] == "MODULE_OCR_REQUIRED"

        tr_blocked = client.post(
            "/api/translate-text/preview",
            json={"text": "Hello", "provider": "free", "source_language": "eng", "target_language": "fa"},
        )
        assert tr_blocked.status_code == 402
        assert tr_blocked.json()["code"] == "MODULE_TRANSLATION_REQUIRED"

    # Independent expiry check: with tok1 (OCR=lifetime, Translation=15d), after 20 days Translation expires while OCR stays active!
    SECURITY_GATE.activate_token(tok1, replace_all_modules=True, now_ts=t0 + 60)
    st_day20 = SECURITY_GATE.inspect_status(now_ts=t0 + 20 * 86400)
    assert st_day20["licensed"] is True
    assert st_day20["modules"]["ocr"]["active"] is True
    assert st_day20["modules"]["translation"]["active"] is False
    assert st_day20["modules"]["translation"]["source"] == "expired"


def test_seller_vault_256b_master_key_customer_crm_and_panel_http(tmp_path: Path, monkeypatch) -> None:
    """v4.17: 256-byte Master Key Vault + Mandatory Name/LastName/Mobile + Customer CRM + Live Remaining Seconds."""
    import threading
    import urllib.error
    import urllib.request
    from http.server import ThreadingHTTPServer
    from license_manager import (
        MASTER_SECRET_BYTES,
        SellerVault,
        build_seller_panel_handler,
        derive_ed25519_seed_from_master_256b,
        normalize_customer_phone,
    )

    # 1. Phone normalization handles Persian/Arabic digits, +98, 0098, and rejects invalid phones
    assert normalize_customer_phone("۰۹۱۲ ۳۴۵-۶۷۸۹") == "09123456789"
    assert normalize_customer_phone("+989361111111") == "09361111111"
    with pytest.raises(ValueError):
        normalize_customer_phone("")
    with pytest.raises(ValueError):
        normalize_customer_phone("09123")

    # 2. Brand-new SellerVault creates a 256-byte (512 hex chars) Master Root Secret + deterministic Ed25519 key
    seller_dir = tmp_path / "seller_v417"
    fake_pub_py = tmp_path / "_public_key.py"
    fake_pub_py.write_text('PUBLIC_VERIFY_KEY_HEX: str = (\n    "' + ("0" * 64) + '"\n)\n', encoding="utf-8")
    vault = SellerVault(seller_dir=seller_dir, public_key_py=fake_pub_py)
    rec = vault.ensure_master_key(sync_source=False)
    assert rec["v"] == 2
    assert rec["master_secret_bytes"] == 256
    assert len(bytes.fromhex(rec["master_secret_256b_hex"])) == MASTER_SECRET_BYTES == 256
    expected_seed = derive_ed25519_seed_from_master_256b(bytes.fromhex(rec["master_secret_256b_hex"]))
    assert rec["private_seed_hex"] == expected_seed.hex()

    # 3. Seamless v1 -> v2 vault upgrade preserves exact Ed25519 signing seed so older issued keys stay valid
    v1_dir = tmp_path / "seller_v1"
    v1_dir.mkdir()
    v1_seed, _ = ed25519_generate_keypair()
    (v1_dir / "seller_master_key.json").write_text(
        json.dumps({"v": 1, "private_seed_hex": v1_seed.hex()}),
        encoding="utf-8",
    )
    v1_vault = SellerVault(seller_dir=v1_dir, public_key_py=fake_pub_py)
    upgraded = v1_vault.ensure_master_key(sync_source=False)
    assert upgraded["private_seed_hex"] == v1_seed.hex()
    assert len(bytes.fromhex(upgraded["master_secret_256b_hex"])) == 256

    # 4. Spin up real Seller Panel HTTP handler & verify mandatory First Name, Last Name & Mobile + Customer CRM
    secret = "test-panel-secret-417"
    server = ThreadingHTTPServer(("127.0.0.1", 0), build_seller_panel_handler(vault, secret))
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def _req(path: str, method: str = "GET", body: dict | None = None, raw: bool = False):
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}",
            data=(json.dumps(body).encode("utf-8") if body is not None else None),
            method=method,
            headers={"Content-Type": "application/json", "X-Seller-Secret": secret},
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                payload = resp.read()
                return resp.status, (payload if raw else json.loads(payload.decode("utf-8")))
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read().decode("utf-8"))

    try:
        # Panel HTML contains modern tabs + mandatory fields
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/?secret={secret}", timeout=5) as html_resp:
            html_text = html_resp.read().decode("utf-8")
            assert html_resp.status == 200
            assert 'id="custFirstName"' in html_text
            assert 'id="custLastName"' in html_text
            assert 'id="custPhone"' in html_text
            assert 'لیست کاربران و مشتریان' in html_text

        # Missing first_name, last_name, or phone MUST be rejected with HTTP 400!
        hwid = compute_hardware_id()
        st_no_fn, err_no_fn = _req(
            "/api/issue",
            "POST",
            {"first_name": "", "last_name": "محمدی", "phone": "09123456789", "hardware_id": hwid},
        )
        assert st_no_fn == 400 and "نام" in err_no_fn["detail"]

        st_no_ln, err_no_ln = _req(
            "/api/issue",
            "POST",
            {"first_name": "علی", "last_name": "", "phone": "09123456789", "hardware_id": hwid},
        )
        assert st_no_ln == 400 and "نام خانوادگی" in err_no_ln["detail"]

        st_no_ph, err_no_ph = _req(
            "/api/issue",
            "POST",
            {"first_name": "علی", "last_name": "محمدی", "phone": "", "hardware_id": hwid},
        )
        assert st_no_ph == 400 and "موبایل" in err_no_ph["detail"]

        # Valid issue saves customer in CRM + normalizes Persian digits + issues valid Ed25519 modular token!
        st_ok, res_ok = _req(
            "/api/issue",
            "POST",
            {
                "first_name": "سارا",
                "last_name": "رضایی",
                "phone": "۰۹۱۲۱۱۱۲۲۳۳",
                "note": "مشتری ویژه تلگرام",
                "hardware_id": hwid,
                "modules": {
                    "ocr": {"plan": "lifetime"},
                    "translation": {"plan": "subscription", "days": 5},
                },
            },
        )
        assert st_ok == 200
        issued = res_ok["issued"]
        assert issued["holder"] == "سارا رضایی"
        assert issued["phone"] == "09121112233"
        assert issued["customerId"].startswith("CUST-")

        # Check /api/info returns enriched customer with live module states & KPI counts
        st_info, info = _req("/api/info")
        assert st_info == 200
        assert info["masterSecretBytes"] == 256
        assert info["stats"]["totalCustomers"] == 1
        assert info["stats"]["expiringCustomers"] == 1  # 5 days <= 7 days threshold!
        cust = info["customers"][0]
        assert cust["fullName"] == "سارا رضایی"
        assert cust["phone"] == "09121112233"
        assert cust["modulesLive"]["ocr"]["state"] == "lifetime"
        assert cust["modulesLive"]["translation"]["state"] == "expiring"
        assert cust["modulesLive"]["editing"]["state"] == "none"

        # CSV export includes UTF-8 BOM and customer data
        st_csv, csv_bytes = _req("/api/customers.csv", raw=True)
        assert st_csv == 200
        assert csv_bytes.startswith(b"\xef\xbb\xbf")
        csv_text = csv_bytes.decode("utf-8-sig")
        assert "سارا" in csv_text and "رضایی" in csv_text and "09121112233" in csv_text

        # Backup & restore into a brand-new SellerVault preserves 256B master key + customers + history!
        st_bak, backup_bundle = _req("/api/backup-key")
        assert st_bak == 200
        restored_vault = SellerVault(seller_dir=tmp_path / "restored_vault", public_key_py=fake_pub_py)
        restored_rec = restored_vault.import_master_key(backup_bundle, sync_source=False)
        assert restored_rec["fingerprint"] == rec["fingerprint"]
        assert len(restored_vault.list_customers()) == 1
        assert restored_vault.list_customers()[0]["phone"] == "09121112233"

        # Verify `inspect_status()` returns exact `remainingSeconds` on `status["license"]`
        monkeypatch.setattr(_public_key, "PUBLIC_VERIFY_KEY_HEX", rec["public_key_hex"])
        SECURITY_GATE.reset_memory_state()
        st_after, _ = SECURITY_GATE.activate_token(issued["token"])
        assert st_after["licensed"] is True
        assert isinstance(st_after["license"]["remainingSeconds"], int)
        assert 4 * 86400 < st_after["license"]["remainingSeconds"] <= 5 * 86400
    finally:
        server.shutdown()
        server.server_close()


