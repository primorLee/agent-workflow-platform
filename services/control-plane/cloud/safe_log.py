"""Small logging helpers that never expose endpoint credentials or identity values."""
from __future__ import annotations

import hashlib
import ipaddress
from urllib.parse import urlsplit


def _host_class(host: str | None) -> str:
    if not host:
        return "missing"
    candidate = host.split("%", 1)[0]
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return "hostname"
    if address.is_loopback:
        return "loopback"
    if address.is_private:
        return "private"
    if address.is_link_local:
        return "link-local"
    if address.is_multicast:
        return "multicast"
    if address.is_unspecified:
        return "unspecified"
    return "public"


def endpoint_label(raw_url: str) -> str:
    """Return scheme, host class, and port only; never userinfo/path/query."""
    try:
        parsed = urlsplit(raw_url)
        scheme = parsed.scheme.lower()
        if scheme not in {"redis", "rediss", "http", "https"}:
            scheme = "other"
        port = parsed.port
        if port is None:
            port = 6380 if scheme == "rediss" else 6379 if scheme == "redis" else 443 if scheme == "https" else 80
        return f"{scheme}://{_host_class(parsed.hostname)}:{port}"
    except (TypeError, ValueError):
        return "invalid://missing:0"


def error_kind(exc: BaseException) -> str:
    """Map backend exceptions to a finite, non-reflective diagnostic label."""
    name = type(exc).__name__.lower()
    if "auth" in name or "permission" in name:
        return "authentication_error"
    if "timeout" in name:
        return "timeout"
    if "connection" in name or "network" in name or "socket" in name:
        return "connection_error"
    if "import" in name or "module" in name:
        return "dependency_unavailable"
    if "protocol" in name or "response" in name:
        return "protocol_error"
    return "backend_error"


def opaque_id(value: object, *, kind: str = "id") -> str:
    digest = hashlib.sha256(str(value).encode("utf-8", errors="replace")).hexdigest()[:12]
    return f"{kind}:{digest}"


def peer_class(value: str | None) -> str:
    return _host_class(value)


__all__ = ["endpoint_label", "error_kind", "opaque_id", "peer_class"]
