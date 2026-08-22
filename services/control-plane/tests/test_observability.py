"""Security regression tests for the wired HTTP observability layer."""
from __future__ import annotations

import importlib
import io
import json
import logging
import re
import string
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request


def _dummy_request(
    path: str = "/metrics",
    *,
    client_ip: str = "127.0.0.1",
    headers: list[tuple[bytes, bytes]] | None = None,
) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "raw_path": path.encode(),
            "headers": headers or [],
            "query_string": b"",
            "client": (client_ip, 12345),
            "scheme": "http",
            "server": ("localhost", 8000),
            "http_version": "1.1",
        }
    )


def _render_log(callback) -> dict:
    import observability

    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(observability.JsonLineFormatter())
    logger = logging.getLogger("test.obs.secure")
    previous_handlers = logger.handlers[:]
    previous_propagate = logger.propagate
    previous_level = logger.level
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.INFO)
    try:
        callback(logger)
    finally:
        logger.handlers = previous_handlers
        logger.propagate = previous_propagate
        logger.setLevel(previous_level)
    return json.loads(stream.getvalue().strip().splitlines()[-1])


def test_new_request_id_uuid_format():
    from cloud import observability

    first = observability._new_request_id()
    second = observability._new_request_id()
    assert len(first) == 16
    assert all(char in string.hexdigits for char in first)
    assert first != second


def test_request_id_is_always_server_minted(client):
    supplied = "client-controlled-correlation-id"
    first = client.get("/health", headers={"X-Request-ID": supplied})
    second = client.get("/health", headers={"X-Request-ID": supplied})
    assert first.status_code == 200
    assert re.fullmatch(r"[0-9a-f]{16}", first.headers["X-Request-ID"])
    assert first.headers["X-Request-ID"] != supplied
    assert second.headers["X-Request-ID"] != supplied
    assert second.headers["X-Request-ID"] != first.headers["X-Request-ID"]


def test_request_id_is_added_when_absent(client):
    response = client.get("/health")
    assert re.fullmatch(r"[0-9a-f]{16}", response.headers["X-Request-ID"])


def test_redact_nested_values_without_mutation():
    from cloud.observability import redact

    original = {
        "headers": {
            "Authorization": "Bearer top-secret-value",
            "X-Trace": "1",
        },
        "nested": {
            "client_secret": "sensitive-value",
            "url": "".join(
                ("https://user", ":pass@", "example.invalid/path?token=secret")
            ),
        },
        "items": [{"access_token": "token-value"}, {"keep": "ok"}],
    }
    result = redact(original)
    assert result["headers"]["Authorization"] == "[REDACTED]"
    assert result["headers"]["X-Trace"] == "1"
    assert result["nested"]["client_secret"] == "[REDACTED]"
    assert result["nested"]["url"] == "https://[REDACTED]"
    assert result["items"][0]["access_token"] == "[REDACTED]"
    assert original["headers"]["Authorization"] == "Bearer top-secret-value"


def test_formatter_does_not_interpolate_logging_arguments():
    secret = "customer-identity-and-secret-token"
    payload = _render_log(
        lambda logger: logger.info("operation failed for %s", secret)
    )
    encoded = json.dumps(payload)
    assert secret not in encoded
    assert payload["message"] == "operation failed for ?"


def test_formatter_omits_exception_message_and_traceback():
    secret = "redis://user:password@host.invalid/tenant?token=leak"

    def emit(logger):
        try:
            raise RuntimeError(secret)
        except RuntimeError as exc:
            # Deliberately pre-format the exception: the formatter must still
            # discard the raw message rather than trying to regex every secret.
            logger.exception(f"backend operation failed: {exc}")

    payload = _render_log(emit)
    encoded = json.dumps(payload)
    assert secret not in encoded
    assert "Traceback" not in encoded
    assert payload["message"] == "exception"
    assert payload["error_kind"] == "backend_error"


def test_formatter_redacts_non_string_message_payload():
    payload = _render_log(
        lambda logger: logger.info(
            {"password": "plain-secret-value", "event": "safe"}
        )
    )
    encoded = json.dumps(payload)
    assert "plain-secret-value" not in encoded
    assert "[REDACTED]" in payload["message"]

def test_formatter_never_dumps_recursive_raw_extras():
    recursive = {"secret": "must-not-escape"}
    recursive["self"] = recursive
    payload = _render_log(
        lambda logger: logger.info("safe_event", extra={"context": recursive})
    )
    assert payload["context"] == "[UNAVAILABLE]"
    assert "must-not-escape" not in json.dumps(payload)

def test_formatter_scrubs_direct_free_text_and_sensitive_extras():
    payload = _render_log(
        lambda logger: logger.info(
            "Bearer token-value-123456789 https://user:pw@example.invalid/x?q=secret",
            extra={
                "authorization": "Bearer another-secret-value",
                "callback": "https://example.invalid/customer?api_key=leak",
            },
        )
    )
    encoded = json.dumps(payload)
    for forbidden in (
        "token-value-123456789",
        "another-secret-value",
        "user:pw",
        "example.invalid",
        "api_key=leak",
    ):
        assert forbidden not in encoded
    assert payload["authorization"] == "[REDACTED]"


def test_request_id_context_is_in_structured_log():
    import observability

    token = observability.request_id_var.set("deadbeefcafef00d")
    try:
        payload = _render_log(lambda logger: logger.info("safe_event"))
    finally:
        observability.request_id_var.reset(token)
    assert payload["request_id"] == "deadbeefcafef00d"


def test_uvicorn_access_logger_is_disabled():
    import observability

    observability.setup_structured_logging("INFO")
    access = logging.getLogger("uvicorn.access")
    assert access.disabled is True
    assert access.propagate is False
    assert access.handlers == []


def _metric_app() -> FastAPI:
    from observability import MetricsMiddleware

    app = FastAPI()
    app.add_middleware(MetricsMiddleware)

    @app.get("/widgets/{widget_id}")
    def widget(widget_id: str):
        return {"id": widget_id}

    @app.get("/boom/{widget_id}")
    def boom(widget_id: str):
        raise RuntimeError("secret exception " + widget_id)

    return app


def test_metric_status_label_is_bounded():
    import observability

    assert observability._safe_status(200) == "200"
    assert observability._safe_status(599) == "599"
    assert observability._safe_status(99) == "other"
    assert observability._safe_status(999999) == "other"
    assert observability._safe_status("attacker-status") == "other"

def test_metrics_use_route_template_not_path_or_query(monkeypatch):
    pytest.importorskip("prometheus_client")
    import observability

    if not observability._PROM_AVAILABLE:
        pytest.skip("prometheus_client unavailable")

    secret_path = "customer-secret-6e7c2d"
    secret_query = "query-secret-813bb2"
    with TestClient(_metric_app()) as test_client:
        response = test_client.get(
            f"/widgets/{secret_path}?api_key={secret_query}"
        )
    assert response.status_code == 200

    exposition = observability.generate_latest().decode("utf-8")
    assert secret_path not in exposition
    assert secret_query not in exposition
    assert 'route="/widgets/{widget_id}"' in exposition


def test_unmatched_path_is_fixed_label(monkeypatch):
    pytest.importorskip("prometheus_client")
    import observability

    unmatched_marker = "synthetic-unmatched-route-marker"
    with TestClient(_metric_app()) as test_client:
        response = test_client.get(
            f"/missing/{unmatched_marker}?marker={unmatched_marker}"
        )
    assert response.status_code == 404

    exposition = observability.generate_latest().decode("utf-8")
    assert unmatched_marker not in exposition
    assert 'route="unmatched"' in exposition


def test_exception_metric_uses_finite_classification():
    pytest.importorskip("prometheus_client")
    import observability

    secret = "exception-secret-customer-91a"
    with TestClient(
        _metric_app(), raise_server_exceptions=False
    ) as test_client:
        response = test_client.get(f"/boom/{secret}")
    assert response.status_code == 500

    exposition = observability.generate_latest().decode("utf-8")
    assert secret not in exposition
    assert 'route="/boom/{widget_id}"' in exposition
    assert 'status="500"' in exposition
    assert 'error_kind="backend_error"' in exposition


def test_metrics_not_available_returns_503(monkeypatch):
    from cloud import observability

    monkeypatch.setattr(observability, "_PROM_AVAILABLE", False)
    response = observability.get_metrics_response(_dummy_request())
    assert response.status_code == 503
    assert b"prometheus_client_unavailable" in response.body


def test_metrics_endpoint_requires_allowlisted_peer(monkeypatch):
    import observability

    if not observability._PROM_AVAILABLE:
        pytest.skip("prometheus_client unavailable")
    monkeypatch.setenv("AWP_METRICS_ALLOW_IPS", "192.0.2.10")
    response = observability.get_metrics_response(
        _dummy_request(client_ip="203.0.113.7")
    )
    assert response.status_code == 403
    assert b"203.0.113.7" not in response.body


def test_metrics_endpoint_bearer_is_exact_and_not_reflected(monkeypatch):
    import observability

    if not observability._PROM_AVAILABLE:
        pytest.skip("prometheus_client unavailable")
    configured = "metrics-only-secret-93828"
    monkeypatch.setenv("AWP_METRICS_ALLOW_IPS", "127.0.0.1")
    monkeypatch.setenv("AWP_METRICS_BEARER_TOKEN", configured)
    rejected = observability.get_metrics_response(
        _dummy_request(
            headers=[(b"authorization", f"bearer {configured}".encode())]
        )
    )
    accepted = observability.get_metrics_response(
        _dummy_request(
            headers=[(b"authorization", f"Bearer {configured}".encode())]
        )
    )
    assert rejected.status_code == 403
    assert configured.encode() not in rejected.body
    assert accepted.status_code == 200


def test_metrics_feature_flag_returns_404(monkeypatch):
    import observability

    monkeypatch.setenv("AWP_PROMETHEUS_ENABLED", "0")
    response = observability.get_metrics_response(_dummy_request())
    assert response.status_code == 404


def test_runtime_bind_guard_rejects_external_cli_override():
    import server
    import observability

    raw_host = "203.0.113.91"
    supplied_request_id = "attacker-selected-request-id"
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(observability.JsonLineFormatter())
    previous_handlers = server._bind_logger.handlers[:]
    previous_propagate = server._bind_logger.propagate
    previous_level = server._bind_logger.level
    server._bind_logger.handlers = [handler]
    server._bind_logger.propagate = False
    server._bind_logger.setLevel(logging.WARNING)
    try:
        with TestClient(
            server.app, base_url=f"http://{raw_host}"
        ) as test_client:
            response = test_client.get(
                "/health?token=query-secret",
                headers={"X-Request-ID": supplied_request_id},
            )
    finally:
        server._bind_logger.handlers = previous_handlers
        server._bind_logger.propagate = previous_propagate
        server._bind_logger.setLevel(previous_level)

    assert response.status_code == 503
    assert response.json() == {
        "error": {
            "code": "service_unavailable",
            "message": "Runtime binding does not match validated configuration",
        }
    }
    response_id = response.headers["X-Request-ID"]
    assert re.fullmatch(r"[0-9a-f]{16}", response_id)
    assert response_id != supplied_request_id
    rendered = stream.getvalue().strip()
    assert raw_host not in rendered
    assert supplied_request_id not in rendered
    assert "query-secret" not in rendered
    payload = json.loads(rendered.splitlines()[-1])
    assert payload["message"] == "runtime_bind_rejected"
    assert payload["error_kind"] == "binding_mismatch"
    assert payload["request_id"] == response_id

def test_metrics_survive_flat_and_package_import():
    pytest.importorskip("prometheus_client")
    flat = sys.modules.get("observability") or importlib.import_module(
        "observability"
    )
    package = sys.modules.get("cloud.observability") or importlib.import_module(
        "cloud.observability"
    )
    if not flat._PROM_AVAILABLE or not package._PROM_AVAILABLE:
        pytest.skip("prometheus_client unavailable")
    for name in ("HTTP_REQUESTS_TOTAL", "HTTP_REQUEST_DURATION"):
        assert getattr(flat, name) is not None
        assert getattr(package, name) is not None
    package.HTTP_REQUESTS_TOTAL.labels(
        method="GET",
        route="/probe",
        status="200",
        error_kind="none",
    ).inc()


def test_retired_observability_surfaces_are_absent():
    import observability

    for name in (
        "TASK_RUNS_TOTAL",
        "UPSTREAM_REQUESTS_TOTAL",
        "DB_QUERY_DURATION",
        "AUTH_BCRYPT_VERIFY_SECONDS",
        "DEPLOY_EVENTS",
        "init_telemetry",
        "set_baggage",
        "traced",
        "counted",
        "record_task_run",
        "record_upstream_request",
        "time_db_query",
    ):
        assert not hasattr(observability, name)
