from __future__ import annotations

import json
import re
from pathlib import Path

import yaml


REPO = Path(__file__).resolve().parents[2]
DEPLOY = REPO / "deploy"
STACK = DEPLOY / "observability-stack.yml"
PROMETHEUS = DEPLOY / "prometheus.yml"
ALERTS = DEPLOY / "prometheus" / "alerts" / "awp.yml"
DASHBOARD = DEPLOY / "grafana" / "dashboards" / "awp-overview.json"
OBSERVABILITY_SOURCE = (
    REPO / "services" / "control-plane" / "cloud" / "observability.py"
)


def _yaml(path: Path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _assert_balanced_promql(expression: str) -> None:
    pairs = {")": "(", "]": "[", "}": "{"}
    stack: list[str] = []
    quoted = False
    escaped = False
    for character in expression:
        if quoted:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
            continue
        if character == '"':
            quoted = True
        elif character in "([{":
            stack.append(character)
        elif character in ")]}":
            assert stack and stack.pop() == pairs[character], expression
    assert not quoted and not stack, expression


def _metric_names(expression: str) -> set[str]:
    return set(
        re.findall(
            r"(?<![A-Za-z0-9_:])([A-Za-z_:][A-Za-z0-9_:]*)\s*(?=\{|\[)",
            expression,
        )
    )


def _selector_labels(expression: str) -> set[str]:
    labels: set[str] = set()
    for selector in re.findall(r"\{([^{}]*)\}", expression):
        labels.update(
            re.findall(
                r"([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!~|!=|=)",
                selector,
            )
        )
    return labels


def test_observability_compose_is_loopback_metrics_only_and_fail_closed():
    stack = _yaml(STACK)
    assert set(stack["services"]) == {"prometheus", "grafana"}
    assert set(stack["secrets"]) == {
        "awp_metrics_bearer_token",
        "grafana_admin_password",
    }

    prometheus = stack["services"]["prometheus"]
    grafana = stack["services"]["grafana"]
    assert prometheus["network_mode"] == "host"
    assert grafana["network_mode"] == "host"
    assert "ports" not in prometheus and "ports" not in grafana
    assert "--web.listen-address=127.0.0.1:9090" in prometheus["command"]
    assert grafana["environment"]["GF_SERVER_HTTP_ADDR"] == "127.0.0.1"
    assert str(grafana["environment"]["GF_SERVER_HTTP_PORT"]) == "3000"

    grafana_environment = grafana["environment"]
    assert (
        grafana_environment["GF_SECURITY_ADMIN_PASSWORD__FILE"]
        == "/run/secrets/grafana_admin_password"
    )
    assert "GF_SECURITY_ADMIN_PASSWORD" not in grafana_environment
    assert grafana_environment["GF_AUTH_ANONYMOUS_ENABLED"] == "false"
    assert grafana_environment["GF_USERS_ALLOW_SIGN_UP"] == "false"

    for name, variable in (
        ("awp_metrics_bearer_token", "AWP_METRICS_BEARER_TOKEN_FILE"),
        ("grafana_admin_password", "AWP_GRAFANA_ADMIN_PASSWORD_FILE"),
    ):
        secret_path = stack["secrets"][name]["file"]
        assert secret_path.startswith("$" + "{" + variable + ":?")
        assert "private " in secret_path
        service = "prometheus" if name.startswith("awp_") else "grafana"
        assert name in stack["services"][service]["secrets"]

    source = STACK.read_text(encoding="utf-8").lower()
    assert "jaeger" not in source
    assert "otel-collector" not in source
    assert "awp-local-dev" not in source


def test_prometheus_scrapes_only_the_wired_guarded_metrics_endpoint():
    config = _yaml(PROMETHEUS)
    assert config["rule_files"] == ["/etc/prometheus/alerts/awp.yml"]
    assert len(config["scrape_configs"]) == 1
    scrape = config["scrape_configs"][0]
    assert scrape["job_name"] == "awp-control-plane"
    assert scrape["metrics_path"] == "/metrics"
    assert scrape["scrape_timeout"] == "5s"
    assert scrape["static_configs"] == [{"targets": ["127.0.0.1:8100"]}]
    assert scrape["authorization"] == {
        "type": "Bearer",
        "credentials_file": "/run/secrets/awp_metrics_bearer_token",
    }

    datasource = _yaml(
        DEPLOY / "grafana" / "provisioning" / "datasources" / "datasources.yml"
    )
    assert len(datasource["datasources"]) == 1
    assert datasource["datasources"][0]["type"] == "prometheus"
    assert datasource["datasources"][0]["url"] == "http://127.0.0.1:9090"


def test_alert_and_dashboard_promql_matches_wired_metric_names_and_labels():
    source = OBSERVABILITY_SOURCE.read_text(encoding="utf-8")
    assert '"http_requests_total"' in source
    assert '["method", "route", "status", "error_kind"]' in source
    assert '"http_request_duration_seconds"' in source
    assert '["method", "route", "error_kind"]' in source

    rules = _yaml(ALERTS)["groups"][0]["rules"]
    assert {rule["alert"] for rule in rules} == {
        "AWPControlPlaneDown",
        "AWPControlPlaneHigh5xxRate",
        "AWPControlPlaneHighP95Latency",
    }
    dashboard = json.loads(DASHBOARD.read_text(encoding="utf-8"))
    assert dashboard["description"].startswith("HTTP metrics emitted by the wired")
    assert len(dashboard["panels"]) == 4

    expressions = [rule["expr"] for rule in rules]
    expressions.extend(
        target["expr"]
        for panel in dashboard["panels"]
        for target in panel["targets"]
    )
    allowed_metrics = {
        "up",
        "http_requests_total",
        "http_request_duration_seconds_bucket",
    }
    allowed_selector_labels = {
        "job",
        "method",
        "route",
        "status",
        "error_kind",
    }
    for expression in expressions:
        _assert_balanced_promql(expression)
        names = _metric_names(expression)
        assert names
        assert names <= allowed_metrics, (expression, names)
        assert _selector_labels(expression) <= allowed_selector_labels
        for match in re.finditer(
            r"(http_requests_total|http_request_duration_seconds_bucket)"
            r"(\{[^{}]*\})",
            expression,
        ):
            assert 'job="awp-control-plane"' in match.group(2)

    dashboard_text = DASHBOARD.read_text(encoding="utf-8")
    legend_labels = set(
        re.findall(r"\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}", dashboard_text)
    )
    assert legend_labels == {"status", "route", "error_kind"}
    assert 'status=~\\"5..\\"' in dashboard_text
    assert "http_request_duration_seconds_bucket" in dashboard_text


def test_vm_otel_scaffold_has_no_go_caller_and_deploy_does_not_reference_it():
    vm_root = REPO / "services" / "vm-agent"
    tracer = vm_root / "internal" / "telemetry" / "tracer.go"
    module_import = (
        '"github.com/primorLee/agent-workflow-platform/'
        'services/vm-agent/internal/telemetry"'
    )
    offenders: list[str] = []
    for path in vm_root.rglob("*.go"):
        if path == tracer:
            continue
        text = path.read_text(encoding="utf-8")
        if module_import in text or re.search(
            r"\btelemetry\.(?:Init|Shutdown|Tracer|Ready|WithBaggage|GetBaggage)\b",
            text,
        ):
            offenders.append(path.relative_to(vm_root).as_posix())
    assert offenders == []

    deploy_references = []
    for path in DEPLOY.rglob("*"):
        if not path.is_file() or path.name == "otel-collector.yaml":
            continue
        if "otel-collector.yaml" in path.read_text(encoding="utf-8"):
            deploy_references.append(path.relative_to(DEPLOY).as_posix())
    assert deploy_references == []
