from __future__ import annotations

import io
from pathlib import Path

import httpx
import numpy as np
import pytest
from PIL import Image, ImageDraw
from support_client import scoped_client

from comic_studio.local_nmt import (
    LOCAL_NMT_MODELS,
    LocalNmtError,
    LocalNmtManager,
    resolve_nllb_pair,
    split_nllb_sentences,
)
from comic_studio.main import create_app


def _png_bytes(size=(320, 200), color="white") -> bytes:
    image = Image.new("RGB", size, color)
    ImageDraw.Draw(image).text((12, 15), "Hello world", fill="black")
    buf = io.BytesIO()
    image.save(buf, "PNG")
    return buf.getvalue()


def _build_real_tiny_nllb_ct2_bundle(target_dir: Path) -> Path:
    """Create a tiny real CTranslate2 + SentencePiece NLLB-compatible model (~25 KB) for fast CPU tests."""
    ctranslate2 = pytest.importorskip("ctranslate2")
    spm = pytest.importorskip("sentencepiece")

    target_dir.mkdir(parents=True, exist_ok=True)
    corpus = target_dir / "_train_corpus.txt"
    corpus.write_text(
        "Hello world! How are you today? Dr. Strange arrived. سلام دنیا خوبی امروز\n" * 12,
        encoding="utf-8",
    )
    spm.SentencePieceTrainer.train(
        input=str(corpus),
        model_prefix=str(target_dir / "sentencepiece.bpe"),
        vocab_size=96,
        user_defined_symbols=[
            "▁سلام",
            "eng_Latn",
            "pes_Arab",
            "arb_Arab",
            "tur_Latn",
            "deu_Latn",
            "fra_Latn",
            "rus_Cyrl",
            "spa_Latn",
            "jpn_Jpan",
            "kor_Hang",
            "zho_Hans",
        ],
        model_type="bpe",
    )
    corpus.unlink(missing_ok=True)

    sp = spm.SentencePieceProcessor(model_file=str(target_dir / "sentencepiece.bpe.model"))
    vocab = [sp.id_to_piece(i) for i in range(sp.get_piece_size())]
    vocab_size = len(vocab)
    dim = 8
    ffn_dim = 16

    spec = ctranslate2.specs.TransformerSpec.from_config(num_layers=(1, 1), num_heads=2)
    spec.register_source_vocabulary(vocab)
    spec.register_target_vocabulary(vocab)

    spec.encoder.embeddings[0].weight = np.zeros((vocab_size, dim), dtype=np.float32)
    spec.decoder.embeddings.weight = np.zeros((vocab_size, dim), dtype=np.float32)

    proj_w = np.zeros((vocab_size, dim), dtype=np.float32)
    proj_b = np.full((vocab_size,), -12.0, dtype=np.float32)
    salam_idx = vocab.index("▁سلام")
    eos_idx = vocab.index("</s>")
    proj_b[salam_idx] = 6.0
    proj_b[eos_idx] = 5.8
    spec.decoder.projection.weight = proj_w
    spec.decoder.projection.bias = proj_b

    for side in (spec.encoder, spec.decoder):
        side.layer_norm.gamma = np.ones((dim,), dtype=np.float32)
        side.layer_norm.beta = np.zeros((dim,), dtype=np.float32)

    for layer in list(spec.encoder.layer) + list(spec.decoder.layer):
        for att_name in ("self_attention", "attention"):
            att = getattr(layer, att_name, None)
            if att is None:
                continue
            att.layer_norm.gamma = np.ones((dim,), dtype=np.float32)
            att.layer_norm.beta = np.zeros((dim,), dtype=np.float32)
            n_lin = len(att.linear)
            att.linear[0].weight = np.zeros(((3 if n_lin == 2 else 1) * dim, dim), dtype=np.float32)
            att.linear[0].bias = np.zeros(((3 if n_lin == 2 else 1) * dim,), dtype=np.float32)
            if n_lin == 3:
                att.linear[1].weight = np.zeros((2 * dim, dim), dtype=np.float32)
                att.linear[1].bias = np.zeros((2 * dim,), dtype=np.float32)
            att.linear[-1].weight = np.zeros((dim, dim), dtype=np.float32)
            att.linear[-1].bias = np.zeros((dim,), dtype=np.float32)
        ff = layer.ffn
        ff.layer_norm.gamma = np.ones((dim,), dtype=np.float32)
        ff.layer_norm.beta = np.zeros((dim,), dtype=np.float32)
        ff.linear_0.weight = np.zeros((ffn_dim, dim), dtype=np.float32)
        ff.linear_0.bias = np.zeros((ffn_dim,), dtype=np.float32)
        ff.linear_1.weight = np.zeros((dim, ffn_dim), dtype=np.float32)
        ff.linear_1.bias = np.zeros((dim,), dtype=np.float32)

    spec.validate()
    spec.save(str(target_dir))
    return target_dir


def test_sentence_splitter_preserves_abbreviations_and_splits_cjk_and_persian():
    # English abbreviations must NOT split prematurely
    parts = split_nllb_sentences("Dr. Strange met Prof. X at Fig. 3! Wait... Really? Yes.")
    assert parts == ["Dr. Strange met Prof. X at Fig. 3!", "Wait...", "Really?", "Yes."]

    # CJK & Persian sentence boundaries split cleanly without spaces or with spaces
    cjk_parts = split_nllb_sentences("これは最初の文です。次の文ですか？はい！")
    assert cjk_parts == ["これは最初の文です。", "次の文ですか？", "はい！"]

    fa_parts = split_nllb_sentences("سلام رفیق؟ حالت چطور است! عالی هستم.")
    assert fa_parts == ["سلام رفیق؟", "حالت چطور است!", "عالی هستم."]


def test_flores_pair_resolution_and_script_guard():
    assert resolve_nllb_pair("eng", "fa", "Hello there") == ("eng_Latn", "pes_Arab")
    assert resolve_nllb_pair("jpn+eng", "fa", "こんにちは") == ("jpn_Jpan", "pes_Arab")
    assert resolve_nllb_pair("fas", "en", "سلام دنیا") == ("pes_Arab", "eng_Latn")
    # Script guard: if OCR language was left on 'fas' while text is Latin and target is 'fa', avoid no-op pes_Arab->pes_Arab
    assert resolve_nllb_pair("fas", "fa", "Hello world") == ("eng_Latn", "pes_Arab")
    # And if OCR was left on 'eng' while text is Persian and target is 'en', detect pes_Arab->eng_Latn
    assert resolve_nllb_pair("eng", "en", "سلام دنیا") == ("pes_Arab", "eng_Latn")


def test_local_nmt_prepare_byte_progress_mirror_fallback_and_cancel(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path / "data"))
    template_dir = _build_real_tiny_nllb_ct2_bundle(tmp_path / "template_bundle")
    files_map = {p.name: p.read_bytes() for p in template_dir.iterdir() if p.is_file()}
    manifest_payload = {
        "siblings": [
            {"rfilename": fname, "size": len(payload)}
            for fname, payload in files_map.items()
        ]
    }

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        calls.append(f"{request.method} {url}")
        # Simulate primary huggingface.co failing so hf-mirror.com fallback is exercised
        if "huggingface.co" in url:
            return httpx.Response(503, text="Mirror needed")
        if "/api/models/" in url:
            return httpx.Response(200, json=manifest_payload)
        for fname, payload in files_map.items():
            if url.endswith(f"/resolve/main/{fname}"):
                return httpx.Response(200, content=payload, headers={"content-length": str(len(payload))})
        return httpx.Response(404)

    mgr = LocalNmtManager(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(mgr, "runtime_installed", lambda: True)
    monkeypatch.setattr("shutil.disk_usage", lambda _p: type("U", (), {"free": 5_000_000_000})())

    progress_events: list[tuple[str, float]] = []
    status = mgr.prepare(
        "nllb-600m",
        progress_cb=lambda msg, prog: progress_events.append((msg, prog)),
    )
    model_info = next(m for m in status["models"] if m["id"] == "nllb-600m")
    assert model_info["ready"] is True
    assert model_info["diskBytes"] > 0
    assert any("hf-mirror.com" in c for c in calls)
    assert progress_events and progress_events[-1][1] == 1.0
    # Verify monotonic progress without backward jumps
    vals = [p for _, p in progress_events]
    assert vals == sorted(vals)
    # Zero leftover .part files
    model_folder = tmp_path / "data" / "models" / "local-nmt" / "nllb-600m"
    assert not list(model_folder.glob("*.part"))

    # Real offline CPU translation & multi-line block correspondence
    outputs = mgr.translate_blocks(
        ["Hello world! How are you?", "42", "Second box text."],
        "eng",
        "fa",
        model_id="nllb-600m",
        beam_size=2,
        keep_loaded=True,
    )
    assert len(outputs) == 3
    assert "سلام" in outputs[0]
    assert outputs[1] == "42"  # Numeric-only line preserved verbatim without wasting CPU
    assert "سلام" in outputs[2]
    assert mgr.status()["loadedModel"] == "nllb-600m"

    # Unload from RAM keeps files on disk
    mgr.unload()
    after_unload = mgr.status("nllb-600m")
    assert after_unload["loadedModel"] is None
    assert next(m for m in after_unload["models"] if m["id"] == "nllb-600m")["ready"] is True

    # Delete model removes files from disk cleanly
    deleted = mgr.delete_model("nllb-600m")
    assert deleted["freedBytes"] > 0
    assert next(m for m in deleted["status"]["models"] if m["id"] == "nllb-600m")["ready"] is False
    assert not model_folder.exists()


def test_local_nmt_cancel_mid_download_cleans_up_part_files(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path / "data"))
    mgr: LocalNmtManager | None = None

    class CancellingStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b"x" * 4096
            assert mgr is not None
            mgr.cancel_prepare()
            yield b"y" * 4096

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/api/models/" in url:
            return httpx.Response(
                200,
                json={"siblings": [{"rfilename": "model.bin", "size": 8192}]},
            )
        return httpx.Response(200, stream=CancellingStream(), headers={"content-length": "8192"})

    mgr = LocalNmtManager(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(mgr, "runtime_installed", lambda: True)
    monkeypatch.setattr("shutil.disk_usage", lambda _p: type("U", (), {"free": 5_000_000_000})())

    with pytest.raises(LocalNmtError, match="لغو"):
        mgr.prepare("nllb-600m")

    model_folder = tmp_path / "data" / "models" / "local-nmt" / "nllb-600m"
    assert not list(model_folder.glob("*.part"))


def test_full_offline_single_sentence_and_multipage_routes_plus_custom_storage(tmp_path, monkeypatch):
    """Verify 100% offline single-sentence & full-page translation routes + custom storage zero-leak."""
    default_drive = tmp_path / "c_drive_default"
    custom_drive = tmp_path / "d_drive_custom"
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(default_drive))
    monkeypatch.delenv("COMIC_STUDIO_CONFIG", raising=False)

    import comic_studio.paths as paths_mod

    paths_mod._CONFIG_CACHE = None

    with scoped_client(create_app()) as client:
        # Switch active storage to custom_drive (v4.00 zero Drive-C leak invariant)
        put_st = client.put(
            "/api/storage-settings",
            json={"custom_path": str(custom_drive), "migrate_existing": True, "cleanup_source": True},
        )
        assert put_st.status_code == 200, put_st.text

        # Install tiny real NLLB CT2 model into the active custom directory's models/local-nmt/nllb-600m
        custom_model_dir = custom_drive / "models" / "local-nmt" / "nllb-600m"
        _build_real_tiny_nllb_ct2_bundle(custom_model_dir)
        assert not (default_drive / "models" / "local-nmt").exists()

        # Check /api/local-nmt/status reports nllb-600m ready
        st_res = client.get("/api/local-nmt/status")
        assert st_res.status_code == 200
        st_json = st_res.json()
        assert next(m for m in st_json["models"] if m["id"] == "nllb-600m")["ready"] is True
        assert next(m for m in st_json["models"] if m["id"] == "nllb-1.3b")["ready"] is False

        # Save AI settings with provider='local' and keep_loaded=False (auto free RAM after job)
        ai_initial = client.get("/api/ai-settings").json()
        save_res = client.put(
            "/api/ai-settings",
            json={
                "provider": "local",
                "target_language": "fa",
                "free_services": ai_initial["free_services"],
                "local_nmt": {
                    "model": "nllb-600m",
                    "beam_size": 2,
                    "source_limit": 4000,
                    "keep_loaded": False,
                },
                "reuse_repeated": True,
                "context_percent": 15,
                "skill_percent": 15,
                "providers": {
                    pid: {
                        "model": pinfo["model"],
                        "base_url": pinfo["base_url"],
                        "response_mode": pinfo.get("response_mode", "auto"),
                        "profiles": [],
                    }
                    for pid, pinfo in ai_initial["providers"].items()
                },
            },
        )
        assert save_res.status_code == 200, save_res.text
        assert save_res.json()["provider"] == "local"
        assert save_res.json()["local_nmt"]["model"] == "nllb-600m"

        # 1. Test /api/local-nmt/test (1-sentence offline quick test in management dialog)
        test_res = client.post(
            "/api/local-nmt/test",
            json={
                "model": "nllb-600m",
                "source_language": "eng",
                "target_language": "fa",
                "sample_text": "Hello world!",
                "beam_size": 2,
                "keep_loaded": False,
            },
        )
        assert test_res.status_code == 200, test_res.text
        assert "سلام" in test_res.json()["translatedText"]
        # Since keep_loaded=False, RAM should be immediately released
        assert client.get("/api/local-nmt/status").json()["loadedModel"] is None

        # 2. Single-sentence / single-box translation via /api/translate-text/context-preview + /context
        single_prev = client.post(
            "/api/translate-text/context-preview",
            json={"text": "Hello world!", "provider": "local", "source_language": "eng", "target_language": "fa"},
        )
        assert single_prev.status_code == 200, single_prev.text
        sp_json = single_prev.json()
        assert sp_json["provider"] == "local"
        assert not sp_json["previewError"]
        assert len(sp_json["requests"]) == 1

        single_exec = client.post(
            "/api/translate-text/context",
            json={
                "text": "Hello world!",
                "provider": "local",
                "source_language": "eng",
                "target_language": "fa",
                "confirmation": sp_json["signature"],
            },
        )
        assert single_exec.status_code == 200, single_exec.text
        assert "سلام" in single_exec.json()["text"]

        # Also verify direct /api/translate-text/preview + /api/translate-text route
        direct_prev = client.post(
            "/api/translate-text/preview",
            json={"text": "How are you today?", "provider": "local", "source_language": "eng", "target_language": "fa"},
        )
        assert direct_prev.status_code == 200
        direct_exec = client.post(
            "/api/translate-text",
            json={
                "text": "How are you today?",
                "provider": "local",
                "source_language": "eng",
                "target_language": "fa",
                "confirmation": direct_prev.json()["signature"],
            },
        )
        assert direct_exec.status_code == 200
        assert "سلام" in direct_exec.json()["text"]

        # 3. Full multi-page project translation via /context-preview + /context-start + /context-step
        proj = client.post("/api/projects", json={"name": "آفلاین چندصفحه‌ای"}).json()
        proj = client.post(
            f"/api/projects/{proj['id']}/files",
            files=[
                ("files", ("p1.png", _png_bytes(), "image/png")),
                ("files", ("p2.png", _png_bytes(), "image/png")),
            ],
        ).json()
        proj["images"][0]["blocks"] = [
            {"id": 1, "x0": 10, "y0": 10, "x1": 130, "y1": 40, "text": "Hello world!", "tr": "", "enabled": True},
            {"id": 2, "x0": 10, "y0": 50, "x1": 130, "y1": 80, "text": "How are you?", "tr": "", "enabled": True},
        ]
        proj["images"][1]["blocks"] = [
            {"id": 1, "x0": 10, "y0": 10, "x1": 130, "y1": 40, "text": "Hello world!", "tr": "", "enabled": True},
        ]
        saved_proj = client.put(f"/api/projects/{proj['id']}/state", json={"state": proj})
        assert saved_proj.status_code == 200
        proj = saved_proj.json()
        image_ids = [im["id"] for im in proj["images"]]

        ctx_prev = client.post(
            f"/api/projects/{proj['id']}/context-preview",
            json={
                "image_ids": image_ids,
                "provider": "local",
                "source_language": "eng",
                "target_language": "fa",
                "only_missing": False,
            },
        )
        assert ctx_prev.status_code == 200, ctx_prev.text
        cp_json = ctx_prev.json()
        assert cp_json["provider"] == "local"
        assert not cp_json["previewError"]
        assert len(cp_json["requests"]) == 1  # page 2's identical block reuses page 1's block!

        started = client.post(
            f"/api/projects/{proj['id']}/context-start",
            json={
                "image_ids": image_ids,
                "provider": "local",
                "source_language": "eng",
                "target_language": "fa",
                "only_missing": False,
                "confirmation": cp_json["signature"],
            },
        )
        assert started.status_code == 200, started.text
        st_run = started.json()
        while not st_run.get("done"):
            step_res = client.post(
                f"/api/projects/{proj['id']}/context-step",
                json={"run_id": st_run["runId"], "completed": st_run.get("completed", 0)},
            )
            assert step_res.status_code == 200, step_res.text
            st_run = step_res.json()

        final_proj = st_run["project"]
        assert "سلام" in final_proj["images"][0]["blocks"][0]["tr"]
        assert "سلام" in final_proj["images"][0]["blocks"][1]["tr"]
        assert final_proj["images"][1]["blocks"][0]["tr"] == final_proj["images"][0]["blocks"][0]["tr"]
        assert final_proj["images"][0]["blocks"][0]["dir"] == "rtl"
        # Auto RAM unload after job completed (keep_loaded=False)
        assert client.get("/api/local-nmt/status").json()["loadedModel"] is None
        # Zero files leaked to default C-drive root
        assert not (default_drive / "models" / "local-nmt").exists()

        # 4. Friendly previewError when selecting an uninstalled model (nllb-1.3b)
        ai_cfg = client.get("/api/ai-settings").json()
        client.put(
            "/api/ai-settings",
            json={
                "provider": "local",
                "target_language": "fa",
                "free_services": ai_cfg["free_services"],
                "local_nmt": {
                    "model": "nllb-1.3b",
                    "beam_size": 2,
                    "source_limit": 4000,
                    "keep_loaded": False,
                },
                "reuse_repeated": True,
                "context_percent": 15,
                "skill_percent": 15,
                "providers": {
                    pid: {
                        "model": pinfo["model"],
                        "base_url": pinfo["base_url"],
                        "response_mode": pinfo.get("response_mode", "auto"),
                        "profiles": [],
                    }
                    for pid, pinfo in ai_cfg["providers"].items()
                },
            },
        )
        missing_prev = client.post(
            "/api/translate-text/context-preview",
            json={"text": "Hello world!", "provider": "local", "source_language": "eng", "target_language": "fa"},
        )
        assert missing_prev.status_code == 200
        assert "دانلود" in (missing_prev.json()["previewError"] or "")
