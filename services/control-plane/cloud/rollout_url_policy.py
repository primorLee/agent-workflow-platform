"""Fail-closed allowlist for independently composed release publishers."""
from __future__ import annotations

import ipaddress
import os
import posixpath
import re
from dataclasses import dataclass
from urllib.parse import unquote, urlsplit

ENV_VAR = "AWP_AGENT_RELEASE_ALLOWED_PREFIXES"
_DEFAULT_PREFIX = "https://releases.example.invalid/releases/"


@dataclass(frozen=True)
class ReleasePrefix:
    host: str
    path: str


def _parse_https_url(raw: str, *, prefix: bool) -> tuple[str, str]:
    if not isinstance(raw, str) or not raw or raw != raw.strip():
        raise ValueError("release URL must be a non-empty canonical string")
    if any(ord(ch) < 0x20 or ch == "\\" for ch in raw):
        raise ValueError("release URL contains forbidden characters")

    parsed = urlsplit(raw)
    if parsed.scheme != "https":
        raise ValueError("release URL scheme must be https")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("release URL must not contain userinfo")
    if parsed.query or parsed.fragment:
        raise ValueError("release URL must not contain query or fragment")
    if not parsed.hostname or parsed.hostname != parsed.hostname.lower():
        raise ValueError("release URL requires a lowercase hostname")
    if parsed.port not in (None, 443):
        raise ValueError("release URL may use only the default HTTPS port")

    host = parsed.hostname
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".localhost"):
        raise ValueError("release URL host must not be loopback")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        try:
            host.encode("ascii")
        except UnicodeEncodeError:
            raise ValueError("release URL hostname must be ASCII") from None
        if len(host) > 253 or "." not in host or host.startswith(".") or host.endswith("."):
            raise ValueError("release URL host is not canonical")
        labels = host.split(".")
        label_pattern = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
        if any(label_pattern.fullmatch(label) is None for label in labels):
            raise ValueError("release URL host is not canonical")
        # A DNS name must end in an alphabetic/punycode label. This rejects
        # legacy IPv4 spellings such as 127.1, octal, and hexadecimal forms
        # that URL clients may reinterpret as loopback after validation.
        if not any("a" <= ch <= "z" for ch in labels[-1]):
            raise ValueError("release URL host is an ambiguous numeric address")
    else:
        if not address.is_global:
            raise ValueError("release URL IP must be globally routable")

    decoded_path = unquote(parsed.path)
    if decoded_path != parsed.path or "//" in parsed.path:
        raise ValueError("release URL path must not use encoded or repeated separators")
    segments = parsed.path.split("/")
    if any(part in {".", ".."} for part in segments):
        raise ValueError("release URL path must not contain dot segments")
    normalized = posixpath.normpath(parsed.path)
    if not normalized.startswith("/"):
        raise ValueError("release URL path must be absolute")

    if prefix:
        if not parsed.path.endswith("/"):
            raise ValueError("release prefix must end with a slash")
    elif parsed.path.endswith("/") or parsed.path == "/":
        raise ValueError("release artifact URL must name a file")
    return host, parsed.path


def _configured_prefixes() -> tuple[ReleasePrefix, ...]:
    raw = os.getenv(ENV_VAR, "").strip()
    values = [part.strip() for part in raw.split(",") if part.strip()] if raw else [_DEFAULT_PREFIX]
    prefixes: list[ReleasePrefix] = []
    for value in values:
        host, path = _parse_https_url(value, prefix=True)
        prefixes.append(ReleasePrefix(host=host, path=path))
    if not prefixes:
        raise ValueError("at least one release prefix is required")
    return tuple(prefixes)


def validate_release_url(url: str) -> str:
    host, path = _parse_https_url(url, prefix=False)
    for allowed in _configured_prefixes():
        if host == allowed.host and path.startswith(allowed.path):
            return url
    raise ValueError("release URL is outside the configured HTTPS prefixes")


def validate_release_urls(urls) -> None:
    for url in urls:
        validate_release_url(url)


__all__ = ["ENV_VAR", "ReleasePrefix", "validate_release_url", "validate_release_urls"]
