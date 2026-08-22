from __future__ import annotations

import os
from pathlib import Path

import pytest

import config
from config import _read_private_secret_file, validate_startup_security


@pytest.mark.parametrize("host", ["127.0.0.1", "127.42.0.9", "::1", "[::1]"])
def test_loopback_requires_an_explicit_non_weak_key(host):
    validate_startup_security(
        host=host,
        environment="dev",
        api_key="test-only-control-plane-key-00000001",
    )
    with pytest.raises(RuntimeError):
        validate_startup_security(host=host, environment="dev", api_key="")


@pytest.mark.parametrize(
    "api_key",
    ["awp-local-dev-key", "CHANGE-ME", "password", "development", "secret"],
)
def test_known_weak_api_keys_are_rejected(api_key):
    with pytest.raises(RuntimeError, match="known weak value"):
        validate_startup_security(host="127.0.0.1", environment="dev", api_key=api_key)


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "localhost", "example.invalid"])
def test_non_loopback_is_always_rejected(host):
    with pytest.raises(RuntimeError, match="numeric loopback"):
        validate_startup_security(
            host=host,
            environment="local-container",
            api_key="generated-" + ("aB3_" * 12),
        )


def test_runtime_bind_must_remain_numeric_loopback(monkeypatch):
    monkeypatch.setattr(config, "ENV", "prod")
    monkeypatch.setattr(config, "HOST", "127.0.0.1")
    assert config.runtime_bind_matches_config("127.0.0.1")
    assert config.runtime_bind_matches_config("127.42.0.9")
    assert not config.runtime_bind_matches_config("0.0.0.0")
    assert not config.runtime_bind_matches_config("example.invalid")
def test_private_secret_file_rejects_links_and_public_permissions(tmp_path: Path):
    secret = tmp_path / "key"
    secret.write_text("generated-" + ("aB3_" * 12) + "\n", encoding="utf-8")
    if os.name != "nt":
        secret.chmod(0o600)
    assert _read_private_secret_file(str(secret)).startswith("generated-")

    if os.name != "nt":
        secret.chmod(0o644)
        with pytest.raises(RuntimeError):
            _read_private_secret_file(str(secret))
        secret.chmod(0o600)

    link = tmp_path / "key-link"
    try:
        link.symlink_to(secret)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are unavailable")
    with pytest.raises(RuntimeError):
        _read_private_secret_file(str(link))


def test_container_defaults_have_no_fixed_key_or_public_listener():
    root = Path(__file__).resolve().parents[3]
    dockerfile = (root / "services" / "control-plane" / "Dockerfile").read_text(encoding="utf-8")
    compose = (root / "deploy" / "local" / "docker-compose.local-dev.yml").read_text(encoding="utf-8")
    assert "AWP_HOST=127.0.0.1" in dockerfile
    assert "--host" not in dockerfile
    assert "awp-local-dev-key" not in dockerfile
    assert "awp-local-dev-key" not in compose
    assert "AWP_DEV_API_KEY_FILE" in compose
    assert "AWP_LOCAL_DEMO_AUTH_BOOTSTRAP" in compose
    assert "AWP_NON_LOOPBACK_BIND_OPT_IN" not in compose
    assert '"127.0.0.1:8100:18100"' in compose
    assert "AWP_HOST: 127.0.0.1" in compose
    assert "AWP_URL: http://127.0.0.1:8100" in compose
    assert "loopback-gateway:" in compose
    assert "haproxy:3.0-alpine" in compose
    gateway = (root / "deploy" / "local" / "haproxy.local.cfg").read_text(encoding="utf-8")
    assert gateway.endswith("\n")
    assert "bind 0.0.0.0:18100" in gateway
    assert "server control 127.0.0.1:8100 check" in gateway
    assert "httplog" not in gateway
    assert 'network_mode: "service:control-plane"' in compose
    assert "http://control-plane:8100" not in compose
    assert 'test -r "$$key_file"' in compose
    assert 'AWP_API_KEY="$$(tr' in compose
