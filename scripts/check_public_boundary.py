#!/usr/bin/env python3
"""Fail on private identity, specialized residue, unsafe artifacts, or secrets.

The script reports only the rule name, relative path, and line number. It never
prints the matched value, which makes it safe to use while reviewing a tree that
may still contain sensitive material. ``--history`` applies the same rules to
reachable Git blobs before a public release is cut. Non-UTF-8 files receive a
byte-preserving metadata scan, so allowed UI assets cannot hide old identity.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class Rule:
    name: str
    pattern: re.Pattern[str]


def _joined(*parts: str) -> str:
    return "".join(parts)


_PRIVATE_IPV4 = (
    r"(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|"
    r"172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})"
)

_SPECIALIZED_DESIGN = _joined(
    r"(?i)(?:\bvirt", r"uoso\b|\bspec", r"tre\b|\bts",
    r"mc[0-9a-z+_-]*\b|\bgp", r"dk[0-9a-z_-]*\b|\bp",
    r"dk[a-z0-9_]*\b|",
    r"\bnet", r"lists?(?:\b|_)|\bsemi", r"conductor\b|\bintegrated cir",
    r"cuit\b|\be", r"da\b|\bic[- ]des", r"ign\b|",
    r"\bband", r"gap\b|\b(?:h|ng)sp", r"ice\b|\bschematic[-_ ]?edi", r"tor\b|",
    r"\brender[-_]schem", r"atic(?:[-_](?:preview|view))?\b|",
    r"\blayout[-_ ]?edi", r"tor\b|\bdemoWave", r"form\b|",
    r"\bsim(?:TaskCre", r"ated|Completed|Failed)\b|\boptTaskSub",
    r"mitted(?:Toast|Msg)?\b|",
    r"\bwaveform[-_]?view", r"er\b|\bbode[-_]?mo", r"de\b|",
    r"\banalog[-_ ]?cir", r"cuits?\b|\bsimulation[_-]b", r"ug\b|",
    r"(?:\u4eff\u771f[^\n]{0,24}(?:\u7535\u8def|\u6ce2\u5f62|",
    r"\u4efb\u52a1|\u7ed3\u679c|\u9875\u9762|\u6a21\u5f0f|\u961f\u5217|",
    r"\u4f5c\u4e1a|\u8fd0\u884c|\u5931\u8d25|\u5b8c\u6210|\u8fdb\u5ea6|",
    r"\u914d\u7f6e)|(?:\u7535\u8def|\u6ce2\u5f62|\u4efb\u52a1|",
    r"\u7ed3\u679c)[^\n]{0,24}\u4eff\u771f)|",
    r"(?:^|[/\\])cad", r"ence(?:[/\\]|$)|",
    r"\bcad", r"ence\b(?=[^\n]{0,96}\b(?:virt", r"uoso|spec",
    r"tre|e", r"da)\b)|\b(?:virt", r"uoso|spec", r"tre|e", r"da)\b",
    r"(?=[^\n]{0,96}\bcad", r"ence\b))",
)

_RETIRED_COMMERCIAL = _joined(
    r"(?i)(?:\b[a-z0-9_]*bil", r"ling[a-z0-9_]*\b|",
    r"(?:^|[/])bil", r"ling(?:[/#?]|$)|",
    r"\bre", r"charge[a-z0-9_]*\b|",
    r"\btop[\s_-]?up[a-z0-9_]*\b|",
    r"\bwe", r"chat\b|",
    r"\u5ba2\u670d\u5fae\u4fe1|\u5fae\u4fe1\u5ba2\u670d|",
    r"\u5145\u503c|\u4f59\u989d|\u8d26\u5355|",
    r"\bcredits?[\s_-]?remaining\b|\bremaining[\s_-]?credits?\b|",
    r"\binvite[\s_-]?code[a-z0-9_]*\b|",
    r"\b(?:input|output)[-_]?pr", r"ice[-_]?per[-_]?(?:1k|million)\b|",
    r"(?:[\"']?bal", r"ance[\"']?\s*:)|",
    r"\bstaging[\s_-]?(?:account|fixture|user|credential|token|invite|code)",
    r"[a-z0-9_]*\b|\baccount[\s_-]?pool[a-z0-9_]*\b)",
)

_INTERNAL_CUSTOMER_INCIDENT = _joined(
    r"(?:",
    r"(?i:\bcus", r"tomer\b)\s+",
    r"(?!(?i:example-customer|incident|support|case|record|account|data)\b)",
    r"(?:['\"][^'\"\n]{2,}['\"]|[A-Za-z][A-Za-z0-9_-]{2,})",
    r"[^\n]{0,96}(?:(?i:\binci", r"dent\b)[^\n]{0,48})?",
    r"\b20\d{2}-\d{2}-\d{2}\b|",
    r"(?i:\binci", r"dent\b)[^\n]{0,64}(?i:\bcus", r"tomer\b)\s+",
    r"(?!(?i:example-customer|incident|support|case|record|account|data)\b)",
    r"(?:['\"][^'\"\n]{2,}['\"]|[A-Za-z][A-Za-z0-9_-]{2,})",
    r"[^\n]{0,96}\b20\d{2}-\d{2}-\d{2}\b|",
    r"(?i:\bcus", r"tomer(?:[-_ ]?id)?\b)\s*[:=#]\s*['\"]?\d{6,}\b)",
)

_RETIRED_HOSTED_ROUTE = _joined(
    r"(?i)(?:/v1/remote/", r"diag(?:/|\b)|",
    r"/v1/(?:support/diagnostic/upl", r"oad|feed",
    r"back(?:/|\b)|legal(?:/|\b)|onboarding/events\b|",
    r"events/onboarding\b|vm-agent(?:/|\b)|agent/status\b|",
    r"preferences/vm-config\b|vm-exec/history\b|trace/upl", r"oad\b)|",
    r"https?://(?:127\.0\.0\.1|localhost):87", r"87/(?:",
    r"static/install-vm-agent\.sh\b|install\.sh\b|docs(?:/|\b)))",
)

_RETIRED_INTERNAL_PRODUCT_NARRATIVE = _joined(
    r"(?i)(?:renamed\s+", r"CC\b|",
    r"feedback_cus", r"tomer-data-must-flow-to-cloud|",
    r"cus", r"tomer-side\s+debug\s+telemetry\s*(?:→|->)\s*cloud)",
)

RULES = (
    Rule(
        "legacy-brand",
        re.compile(
            _joined(r"(?:", "chip", "flow", "|amp", "copilot", r")"),
            re.IGNORECASE,
        ),
    ),
    Rule(
        "legacy-domain",
        re.compile(_joined("chip", "flow", "ai", r"\.com"), re.IGNORECASE),
    ),
    Rule("private-repo-path", re.compile(_joined(r"/srv/", "cto", r"/repo-full"))),
    Rule(
        "credential-store-path",
        re.compile(
            _joined(r"\.chip", "flow", "-secrets|cc", "-secrets"),
            re.IGNORECASE,
        ),
    ),
    Rule(
        "private-key-marker",
        re.compile(_joined("-----", r"BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY")),
    ),
    Rule(
        "github-token-shape",
        re.compile(_joined(r"(?:gh[pousr]_|github", r"_pat_)[A-Za-z0-9_]{20,}")),
    ),
    Rule(
        "openai-token-shape",
        re.compile(_joined(r"\bsk", r"-[A-Za-z0-9_-]{20,}\b")),
    ),
    Rule(
        "legacy-token-shape",
        re.compile(_joined(r"\bcf_", r"(?:live|test)_[A-Za-z0-9_-]{6,}\b")),
    ),
    Rule(
        "aws-access-key-shape",
        re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    ),
    Rule(
        "gitlab-token-shape",
        re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b"),
    ),
    Rule(
        "slack-token-shape",
        re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    ),
    Rule(
        "google-api-key-shape",
        re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    ),
    Rule(
        "npm-token-shape",
        re.compile(r"\bnpm_[A-Za-z0-9]{36}\b"),
    ),
    Rule(
        "huggingface-token-shape",
        re.compile(r"\bhf_[A-Za-z0-9]{20,}\b"),
    ),
    Rule(
        "inline-ssh-password",
        re.compile(
            _joined(r"\bssh", r"pass\s+(?:-p|--password)(?:\s+|=)"),
            re.IGNORECASE,
        ),
    ),
    Rule(
        "remote-account-fixture",
        re.compile(
            r"(?i)\b(?:password|passwd)\s*[:=]\s*"
            r"(?:process\.env\.[A-Z0-9_]+\s*\|\|\s*)?"
            r"['\"][A-Za-z][A-Za-z0-9._-]*20\d{6}[!@#$%^&*]['\"]"
        ),
    ),
    Rule(
        "host-oauth-debug",
        re.compile(
            _joined(
                r"(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN)|\.claude[/\\]",
                r"\.credentials\.json)",
            )
        ),
    ),
    Rule(
        "private-registry-url",
        re.compile(
            r"(?i)(?:\"resolved\"\s*:\s*\"|(?:^|\s)registry\s*=\s*)"
            r"https?://(?!(?:registry\.npmjs\.org|github\.com|"
            r"codeload\.github\.com)(?=[:/]))"
        ),
    ),
    # Match RFC1918 addresses only when they look like configured endpoints.
    # Generic network parsing and RFC 5737 documentation examples remain valid.
    Rule(
        "private-network-endpoint",
        re.compile(
            rf"(?i)(?:(?:https?|wss?)://{_PRIVATE_IPV4}\b|"
            rf"(?:host|hostname|ip|address|endpoint|url)\s*[:=]\s*"
            rf"(?:(?:process\.env\.[A-Z0-9_]+|[A-Za-z_$][\w.$]*)\s*(?:\|\||\?\?)\s*)?"
            rf"['\"]?(?:[^\s'\"]+@)?{_PRIVATE_IPV4}\b|"
            rf"ssh\s+[^\s]+@{_PRIVATE_IPV4}\b)"
        ),
    ),
    Rule(
        "retired-cli-override",
        re.compile(_joined(r"\bAWP_CC_CLI_", r"OVERRIDE\b")),
    ),
    Rule(
        "insecure-ssh-host-key-policy",
        re.compile(
            _joined(
                r"(?i)(?:StrictHostKey",
                r"Checking(?:=|\s+)no|UserKnownHosts",
                r"File(?:=|\s+)(?:/dev/null|NUL)\b)",
            )
        ),
    ),
    Rule("specialized-design-domain", re.compile(_SPECIALIZED_DESIGN)),
    Rule("retired-commercial-content", re.compile(_RETIRED_COMMERCIAL)),
    Rule("internal-customer-incident", re.compile(_INTERNAL_CUSTOMER_INCIDENT)),
    Rule("retired-hosted-route", re.compile(_RETIRED_HOSTED_ROUTE)),
    Rule(
        "retired-internal-product-narrative",
        re.compile(_RETIRED_INTERNAL_PRODUCT_NARRATIVE),
    ),
    Rule(
        "machine-specific-drive-path",
        re.compile(_joined(r"\b[A-Za-z]:\\", r"\d{2,}(?:\\|$)")),
    ),
    Rule(
        "local-user-path",
        re.compile(
            _joined(
                r"(?:[A-Za-z]:\\Users\\(?!Public\\|Example\\)|/ho",
                r"me/(?!runner/|user/|example/))",
            )
        ),
    ),
)

# Policy sources construct deny-list tokens and are scanned like ordinary files.

@dataclass(frozen=True)
class SemanticAllowance:
    rule: str
    path: Path
    required_fragment: str
    line_sha256: str
    purpose: str


# Exact-line allowances for generic security/runtime handlers. The readable
# fragment documents the safe behavior; the digest prevents an allowance from
# masking any future edit or a second matching line in the same file.
SEMANTIC_ALLOWANCES = (
    SemanticAllowance(
        "credential-store-path",
        Path(".gitignore"),
        _joined("**/cc", "-secrets/"),
        "ff0a593698118e0e7ca40c35bfbed0fc2d78bb17ff74b6ce5598af123b7ed142",
        "defensive ignore entry",
    ),
    SemanticAllowance(
        "specialized-design-domain",
        Path("PROVENANCE.md"),
        "credentials, customer data",
        "99ac7464c0f92f29a8c92719bb9fa7e41012964868e8c7326957406cea5bf4cb",
        "public extraction exclusion summary",
    ),
    SemanticAllowance(
        "specialized-design-domain",
        Path("README.md"),
        "hosted-service integrations",
        "5c8cbd097a81c8fd8f125302a13d7d255aec67065493296b40b1cc53eca42879",
        "public extraction exclusion summary",
    ),
    SemanticAllowance(
        "specialized-design-domain",
        Path("README.md"),
        "synthetic/example/demo filename",
        "1638f9cfe7b78c490b19d28de57fc005d414a898e73d032ccd1b5405b9acf1db",
        "fail-closed artifact policy summary",
    ),
    SemanticAllowance(
        "specialized-design-domain",
        Path("docs/public-release-boundary.md"),
        "generated data, and runtime",
        "c3d9d59ab75ed42fc4d3de850abe08b6a805d62ab6cb5583b7d02c0a89f0e7d6",
        "public extraction boundary summary",
    ),
    SemanticAllowance(
        "specialized-design-domain",
        Path("docs/public-release-boundary.md"),
        "simulation assets, and warm-start data",
        "3865adcdfc86a2ce9ed95e431965fa554ffa9872151270ed4fca6ea17e2a9b16",
        "excluded specialized assets summary",
    ),
    SemanticAllowance(
        "specialized-design-domain",
        Path("apps/desktop/PROVENANCE.md"),
        "horizontal engineering",
        "886d53ba7929beedc1847a434c0d9b2ac0e65394a32cccfc4e05612dd4b915ce",
        "desktop extraction boundary summary",
    ),
    SemanticAllowance(
        "retired-commercial-content",
        Path("apps/desktop/PROVENANCE.md"),
        _joined("bil", "ling, invite"),
        "3f6e8e627c8b1d0fec8bc4467e699fc6d362a02f34e3021c5a78b72c8e49a56f",
        "desktop extraction exclusion summary",
    ),
    SemanticAllowance(
        "retired-commercial-content",
        Path("docs/public-release-boundary.md"),
        _joined("bil", "ling, account-", "pool"),
        "a8c491decc8ab2512388187d61361a60e964a33db090f164ad4deb9a794c1793",
        "excluded commercial integration summary",
    ),
    SemanticAllowance(
        "retired-commercial-content",
        Path("workflows/README.md"),
        _joined("product bil", "ling/authentication code"),
        "6e702484d7e3fdc651c6bf05543f34ce99e052a66a4b67a087ab6036400376fe",
        "workflow extraction exclusion summary",
    ),
    SemanticAllowance(
        "retired-commercial-content",
        Path("workflows/PROVENANCE.md"),
        _joined("bil", "ling integration"),
        "9725ffc13148acf41d0bb547b7e21bf261a4efe70f591b155f27e93d3c374bf2",
        "workflow provenance exclusion summary",
    ),
)

SKIP_DIRS = {
    ".git",
    ".venv",
    "node_modules",
    "coverage",
    "test-results",
    "playwright-report",
    "__pycache__",
    ".pytest_cache",
    ".expo",
}

SKIP_FILES: set[str] = set()

MAX_FILE_BYTES = 2 * 1024 * 1024

HIGH_RISK_NAME_PATTERNS = (
    (
        "staging-or-production-fixture-name",
        re.compile(r"(?i)(?:real[-_.]?staging|staging[-_.]?account|prod[-_.]?probe)"),
    ),
    (
        "retired-commercial-surface-name",
        re.compile(
            _joined(
                r"(?i)(?:^|[-_.])(?:bil", r"ling|customer[-_.]?setup)(?:[-_.]|$)"
            )
        ),
    ),
    (
        "retired-release-note-name",
        re.compile(r"(?i)^release[-_.]?notes?[-_.]?v1\.5(?:\.0)?\.md$"),
    ),
)
TEST_DEBUG_NAME_PATTERN = re.compile(
    _joined(
        r"(?i)(?:^|[-_.])(?:real|staging|prod|production|customer|bil",
        r"ling)(?:[-_.]|$)",
    )
)
SPECIALIZED_DESIGN_NAME_PATTERN = re.compile(
    _joined(
        r"(?i)(?:^|[-_.])(?:e", r"da|p", r"dk|net", r"list|virt",
        r"uoso|spec", r"tre|ts", r"mc[0-9a-z+_-]*)(?:[-_.]|$)|",
        r"(?:^|[-_.])ic[-_.]?des", r"ign(?:[-_.]|$)|",
        r"^layout[_-]preview\.svg$|^auto[-_]?router\.ts$",
    )
)
PRIVATE_KEY_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"}
LIVE_STATE_NAMES = {"run-state.json", "guardian-history.jsonl", "guardian.log"}
IC_DESIGN_SUFFIXES = {
    ".cdl", ".cir", ".gds", ".gdsii", ".oas", ".oasis", ".scs", ".sp",
    _joined(".spec", "tre"), ".spice",
}
OPAQUE_FIXTURE_SUFFIXES = {
    ".avi", ".bmp", ".doc", ".docx", ".gif", ".jpeg", ".jpg", ".m4a",
    ".mov", ".mp3", ".mp4", ".ogg", ".pdf", ".png", ".ppt", ".pptx",
    ".tif", ".tiff", ".wav", ".webm", ".webp", ".xls", ".xlsx",
}
ARCHIVE_SUFFIXES = {
    ".7z", ".bz2", ".gz", ".jar", ".rar", ".tar", ".tgz", ".war", ".whl",
    ".xz", ".zip",
}
PACKAGED_BINARY_SUFFIXES = {
    ".appimage", ".bin", ".deb", ".dll", ".dylib", ".exe", ".msi", ".rpm",
    ".so", ".wasm",
}
REVIEWED_BINARY_ASSET_SUFFIXES = {
    ".bmp", ".gif", ".icns", ".ico", ".jpeg", ".jpg", ".otf", ".png",
    ".tif", ".tiff", ".ttf", ".webp", ".woff", ".woff2",
}
RUNTIME_DATA_SUFFIXES = {
    ".db", ".db-shm", ".db-wal", ".jsonl", ".log", ".sqlite", ".sqlite3",
}
SYNTHETIC_NAME_PATTERN = re.compile(
    r"(?i)(?:^|[-_.])(?:synthetic|example|demo)(?:[-_.]|$)"
)


def has_skipped_part(parts: Iterable[str]) -> bool:
    return any(part in SKIP_DIRS for part in parts)


def iter_files(root: Path) -> Iterable[Path]:
    for path in root.rglob("*"):
        if not path.is_file() or path.name in SKIP_FILES:
            continue
        if has_skipped_part(path.relative_to(root).parts):
            continue
        yield path


def is_test_path(path: Path) -> bool:
    parts = {part.lower() for part in path.parts}
    name = path.name.lower()
    return bool(
        parts & {"test", "tests", "__tests__", "fixtures", "e2e"}
        or name.startswith("test_")
        or ".test." in name
        or ".spec." in name
    )


def is_debug_path(path: Path) -> bool:
    name = path.name.lower()
    parts = {part.lower() for part in path.parts}
    return bool(
        parts & {"debug", "debugging"}
        or name.startswith("debug-")
        or re.search(r"(?:^|[-_.])smoke(?:[-_.]|$)", name)
    )


def is_test_or_debug_path(path: Path) -> bool:
    return is_test_path(path) or is_debug_path(path)


REGISTRY_ONLY_RULES = {"private-registry-url"}
REGISTRY_FILES = {
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    ".npmrc",
}


def rule_applies(rule: Rule, relative: Path) -> bool:
    if rule.name in REGISTRY_ONLY_RULES and relative.name.lower() not in REGISTRY_FILES:
        return False
    return True


def _line_sha256(line: str) -> str:
    return hashlib.sha256(line.encode("utf-8")).hexdigest()


def semantic_allowance_matches(
    rule: Rule,
    relative: Path,
    line: str,
) -> bool:
    digest = _line_sha256(line)
    return any(
        allowance.rule == rule.name
        and allowance.path == relative
        and allowance.required_fragment in line
        and allowance.line_sha256 == digest
        for allowance in SEMANTIC_ALLOWANCES
    )


def validate_semantic_allowances(
    root: Path,
) -> list[tuple[str, Path, int]]:
    """Fail closed when an allowance is malformed, stale, or duplicated."""
    findings: list[tuple[str, Path, int]] = []
    rules_by_name = {rule.name: rule for rule in RULES}
    seen: set[tuple[str, Path, str]] = set()
    cached_lines: dict[Path, list[str] | None] = {}

    for allowance in SEMANTIC_ALLOWANCES:
        identity = (allowance.rule, allowance.path, allowance.line_sha256)
        rule = rules_by_name.get(allowance.rule)
        valid_path = (
            not allowance.path.is_absolute()
            and ".." not in allowance.path.parts
        )
        valid_fields = bool(
            allowance.required_fragment
            and allowance.purpose
            and re.fullmatch(r"[0-9a-f]{64}", allowance.line_sha256)
        )
        if identity in seen or rule is None or not valid_path or not valid_fields:
            findings.append(("semantic-allowance-invalid", allowance.path, 0))
            continue
        seen.add(identity)

        if allowance.path not in cached_lines:
            try:
                cached_lines[allowance.path] = (root / allowance.path).read_text(
                    encoding="utf-8"
                ).splitlines()
            except (OSError, UnicodeDecodeError):
                cached_lines[allowance.path] = None
        lines = cached_lines[allowance.path]
        if lines is None:
            findings.append(("semantic-allowance-stale", allowance.path, 0))
            continue

        matches = [
            line_number
            for line_number, line in enumerate(lines, start=1)
            if allowance.required_fragment in line
            and allowance.line_sha256 == _line_sha256(line)
            and rule.pattern.search(line)
        ]
        if len(matches) != 1:
            findings.append(("semantic-allowance-stale", allowance.path, 0))

    return findings


def scan_text(text: str, relative: Path) -> Iterable[tuple[str, Path, int]]:
    for line_number, line in enumerate(text.splitlines(), start=1):
        for rule in RULES:
            if (
                rule_applies(rule, relative)
                and rule.pattern.search(line)
                and not semantic_allowance_matches(rule, relative, line)
            ):
                yield rule.name, relative, line_number


def scan_binary_metadata(
    data: bytes,
    relative: Path,
) -> Iterable[tuple[str, Path, int]]:
    """Scan byte-preserving metadata without attempting to render binaries."""
    metadata = data.decode("latin-1")
    for rule in RULES:
        if rule_applies(rule, relative) and rule.pattern.search(metadata):
            yield f"binary-{rule.name}", relative, 0


def scan_path_name(relative: Path) -> Iterable[tuple[str, Path, int]]:
    """Apply filename policy to a current or historical repository path."""
    lower_name = relative.name.lower()
    matched_global = False
    for rule_name, pattern in HIGH_RISK_NAME_PATTERNS:
        if any(pattern.search(part.lower()) for part in relative.parts):
            matched_global = True
            yield rule_name, relative, 0
    if not matched_global and is_test_or_debug_path(relative):
        if any(TEST_DEBUG_NAME_PATTERN.search(part.lower()) for part in relative.parts):
            yield "test-debug-environment-name", relative, 0
    if any(SPECIALIZED_DESIGN_NAME_PATTERN.search(part) for part in relative.parts):
        yield "specialized-design-domain-name", relative, 0
    if relative.suffix.lower() in PRIVATE_KEY_SUFFIXES:
        yield "private-key-filename", relative, 0
    if relative.suffix.lower() in IC_DESIGN_SUFFIXES:
        yield _joined("ic-", "design-artifact-filename"), relative, 0
    suffix = relative.suffix.lower()
    if suffix in ARCHIVE_SUFFIXES:
        yield "archive-filename", relative, 0
    if suffix in PACKAGED_BINARY_SUFFIXES:
        yield "packaged-binary-filename", relative, 0
    if suffix in RUNTIME_DATA_SUFFIXES:
        if suffix != ".jsonl" or not SYNTHETIC_NAME_PATTERN.search(lower_name):
            yield "runtime-data-filename", relative, 0
    if is_test_path(relative) and suffix in OPAQUE_FIXTURE_SUFFIXES:
        yield "opaque-test-fixture-filename", relative, 0
    if lower_name in LIVE_STATE_NAMES:
        yield "live-runtime-state-filename", relative, 0


def self_check() -> bool:
    if has_skipped_part(("apps", "desktop", "dist")):
        return False
    if not has_skipped_part(("apps", "desktop", "node_modules", "dist")):
        return False
    cases = (
        (_joined("chip", "flow"), "legacy-brand"),
        (_joined("amp", "copilot"), "legacy-brand"),
        (_joined("https://", "chip", "flow", "ai.com"), "legacy-domain"),
        (_joined("/srv/", "cto", "/repo-full"), "private-repo-path"),
        (_joined("ghp_", "A" * 24), "github-token-shape"),
        (_joined("sk-", "B" * 24), "openai-token-shape"),
        (_joined("cf_", "live_", "C" * 12), "legacy-token-shape"),
        (_joined("AKIA", "D" * 16), "aws-access-key-shape"),
        (_joined("glpat-", "E" * 20), "gitlab-token-shape"),
        (_joined("xoxb-", "F" * 24), "slack-token-shape"),
        (_joined("AIza", "G" * 35), "google-api-key-shape"),
        (_joined("npm_", "H" * 36), "npm-token-shape"),
        (_joined("hf_", "I" * 20), "huggingface-token-shape"),
        (_joined("ssh", "pass -p example"), "inline-ssh-password"),
        (_joined("AWP_CC_CLI_", "OVERRIDE"), "retired-cli-override"),
        (_joined("StrictHostKey", "Checking=no"), "insecure-ssh-host-key-policy"),
        (_joined("UserKnownHosts", "File=/dev/null"), "insecure-ssh-host-key-policy"),
        (_joined("Virt", "uoso runtime"), "specialized-design-domain"),
        (_joined("Spec", "tre job"), "specialized-design-domain"),
        (_joined("TS", "MC28"), "specialized-design-domain"),
        (_joined("P", "DK setup"), "specialized-design-domain"),
        (_joined("p", "dkValid"), "specialized-design-domain"),
        (_joined("band", "gap"), "specialized-design-domain"),
        (_joined("hsp", "ice"), "specialized-design-domain"),
        (_joined("ngsp", "ice"), "specialized-design-domain"),
        (_joined("schematic", "Editor"), "specialized-design-domain"),
        (_joined("render_schem", "atic_preview"), "specialized-design-domain"),
        (_joined("render_schem", "atic"), "specialized-design-domain"),
        (_joined("net", "list_scs"), "specialized-design-domain"),
        (_joined("leftover net", "lists"), "specialized-design-domain"),
        (_joined("layout-", "editor"), "specialized-design-domain"),
        (_joined("demoWave", "form"), "specialized-design-domain"),
        (_joined("simTaskCre", "ated"), "specialized-design-domain"),
        (_joined("optTaskSub", "mittedToast"), "specialized-design-domain"),
        (_joined("waveform", "Viewer"), "specialized-design-domain"),
        (_joined("bode", "Mode"), "specialized-design-domain"),
        (_joined("analog ", "circuit"), "specialized-design-domain"),
        (_joined("simulation_", "bug"), "specialized-design-domain"),
        (_joined("\u4eff\u771f", "\u4efb\u52a1"), "specialized-design-domain"),
        (_joined("net", "list artifact"), "specialized-design-domain"),
        (_joined("/tools/cad", "ence/runtime"), "specialized-design-domain"),
        (_joined("D:\\", "111\\vmrun.exe"), "machine-specific-drive-path"),
        (_joined("endpoint=http://10.", "9.8.7:9000"), "private-network-endpoint"),
        (
            _joined("sshHost = process.env.AWP_LAB_HOST || 'user@10.", "9.8.7'"),
            "private-network-endpoint",
        ),
        (
            _joined(r"data_dir=C:\Users", r"\ExampleUser\private"),
            "local-user-path",
        ),
        (_joined("goToBil", "ling"), "retired-commercial-content"),
        (_joined("bil", "ling:{enabled:true}"), "retired-commercial-content"),
        (_joined("/v1/bil", "ling/balance"), "retired-commercial-content"),
        (_joined("input_pr", "ice_per_1k?: number"), "retired-commercial-content"),
        (_joined("{ bal", "ance: 0 }"), "retired-commercial-content"),
        (_joined("re", "chargePrompt"), "retired-commercial-content"),
        (_joined("Top ", "Up"), "retired-commercial-content"),
        (_joined("support We", "Chat"), "retired-commercial-content"),
        (_joined("credits re", "maining"), "retired-commercial-content"),
        (_joined("invite", "Code"), "retired-commercial-content"),
        (_joined("staging", "Fixture"), "retired-commercial-content"),
        (_joined("\u5145", "\u503c"), "retired-commercial-content"),
        (
            _joined("cus", "tomer Ac", "me incident 2026-08-22"),
            "internal-customer-incident",
        ),
        (_joined("cus", "tomer_id:", "12345678"), "internal-customer-incident"),
        (
            _joined("/v1/remote/", "diag/", "pending"),
            "retired-hosted-route",
        ),
        (
            _joined("http://127.0.0.1:87", "87/static/install-vm-agent.sh"),
            "retired-hosted-route",
        ),
        (
            _joined("/v1/support/diagnostic/upl", "oad"),
            "retired-hosted-route",
        ),
        (
            _joined("/v1/agent/", "status"),
            "retired-hosted-route",
        ),
        (
            _joined("http://127.0.0.1:87", "87/docs/troubleshooting"),
            "retired-hosted-route",
        ),
    )
    for value, expected in cases:
        names = {name for name, _path, _line in scan_text(value, Path("fixture.txt"))}
        if expected not in names:
            return False
    safe_values = (
        "documentation endpoint http://192.0.2.10",
        "generic RFC1918 range 10.0.0.0/8",
        "heartbeat cadence is configurable",
        "generic tenant routing for multiple users",
        "customer success metadata is configurable",
        "optimization task submitted",
        "simulation results are streamed",
        "customer incident response playbook 2026-08-22",
        "example-customer incident fixture 2026-08-22",
        "customer_id schema field",
        "http://127.0.0.1:8787/events",
        r"example=C:\Users\Example\project",
        "sshpass -f password-file",
    )
    if not all(not list(scan_text(value, Path("fixture.txt"))) for value in safe_values):
        return False
    # An allowance is bound to one exact line; a new value in the same source
    # file must still be reported.
    tampered_line = _joined(r"app.asar C:\Users", r"\ActualUser\private")
    tampered_names = {
        name
        for name, _path, _line in scan_text(
            tampered_line,
            Path("apps/desktop/electron/cc/mcp-config-renderer.ts"),
        )
    }
    if "local-user-path" not in tampered_names:
        return False
    path_cases = (
        (Path("tests/real-staging.spec.ts"), "staging-or-production-fixture-name"),
        (Path("tests/local-real.spec.ts"), "test-debug-environment-name"),
        (Path(_joined("src/bil", "ling/index.ts")), "retired-commercial-surface-name"),
        (Path("fixtures/private.key"), "private-key-filename"),
        (Path("resources/test-ota.scs"), _joined("ic-", "design-artifact-filename")),
        (Path(_joined("src/e", "da-detect.ts")), "specialized-design-domain-name"),
        (Path("public/layout_preview.svg"), "specialized-design-domain-name"),
        (Path("src/utils/autoRouter.ts"), "specialized-design-domain-name"),
        (
            Path("apps/desktop/RELEASE-NOTES-v1.5.0.md"),
            "retired-release-note-name",
        ),
        (Path("release/payload.zip"), "archive-filename"),
        (Path("release/agent.exe"), "packaged-binary-filename"),
        (Path("runtime/state.db"), "runtime-data-filename"),
        (Path("runtime/state.synthetic.db"), "runtime-data-filename"),
        (Path("tests/fixtures/customer.pdf"), "opaque-test-fixture-filename"),
        (Path("tests/fixtures/document.synthetic.pdf"), "opaque-test-fixture-filename"),
        (Path("runtime/run-state.json"), "live-runtime-state-filename"),
    )
    for path, expected in path_cases:
        names = {name for name, _path, _line in scan_path_name(path)}
        if expected not in names:
            return False
    safe_paths = (
        Path("docs/production-lessons.md"),
        Path("examples/run-state.synthetic.json"),
        Path("tests/realpath.spec.ts"),
        Path("public/awp-icon.png"),
        Path("src/metadata.ts"),
        Path("docs/heartbeat-cadence.md"),
        Path("public/layout_preview_card.svg"),
        Path("src/router/autoRoutes.ts"),
        Path("apps/desktop/RELEASE-NOTES-v2.0.0.md"),
    )
    if not all(not list(scan_path_name(path)) for path in safe_paths):
        return False
    content_cases = (
        (
            _joined("const PASSWORD = 'Demo-", "20260822!'"),
            Path("e2e/account.spec.ts"),
            "remote-account-fixture",
        ),
        (
            _joined("const key = process.env.ANTHROPIC_", "API_KEY"),
            Path("scripts/debug-runtime-smoke.mjs"),
            "host-oauth-debug",
        ),
        (
            '"resolved": "https://packages.example.test/pkg.tgz"',
            Path("package-lock.json"),
            "private-registry-url",
        ),
    )
    for value, path, expected in content_cases:
        names = {name for name, _path, _line in scan_text(value, path)}
        if expected not in names:
            return False
    public_lock = '"resolved": "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"'
    if list(scan_text(public_lock, Path("package-lock.json"))):
        return False
    binary_sample = b"\x89PNG" + _joined("chip", "flow").encode("ascii")
    binary_names = {
        name
        for name, _path, _line in scan_binary_metadata(
            binary_sample,
            Path("public/awp-icon.png"),
        )
    }
    return "binary-legacy-brand" in binary_names


def scan(root: Path) -> list[tuple[str, Path, int]]:
    findings = validate_semantic_allowances(root)
    for path in iter_files(root):
        relative = path.relative_to(root)
        findings.extend(scan_path_name(relative))
        try:
            size = path.stat().st_size
        except OSError:
            findings.append(("file-metadata-unavailable", relative, 0))
            continue
        if size > MAX_FILE_BYTES:
            findings.append(("oversize-unscanned-file", relative, 0))
            continue
        try:
            data = path.read_bytes()
        except OSError:
            findings.append(("file-read-unavailable", relative, 0))
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            findings.extend(scan_binary_metadata(data, relative))
            if relative.suffix.lower() not in REVIEWED_BINARY_ASSET_SUFFIXES:
                findings.append(("non-utf8-unreviewed-file", relative, 0))
        else:
            findings.extend(scan_text(text, relative))
    return findings


def scan_history(root: Path) -> list[tuple[str, Path, int]]:
    """Scan every reachable blob without checking files out or printing data."""
    try:
        listed = subprocess.run(
            ["git", "rev-list", "--objects", "--all"],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        return [("git-history-unavailable", Path(".git"), 0)]
    if listed.returncode != 0:
        return [("git-history-unavailable", Path(".git"), 0)]

    findings: list[tuple[str, Path, int]] = []
    seen: set[tuple[str, Path, int]] = set()
    for entry in listed.stdout.splitlines():
        object_id, separator, raw_path = entry.partition(" ")
        if not separator or not raw_path:
            continue
        relative = Path(raw_path)
        if relative.name in SKIP_FILES or has_skipped_part(relative.parts):
            continue
        for finding in scan_path_name(relative):
            if finding not in seen:
                seen.add(finding)
                findings.append(finding)
        try:
            metadata_result = subprocess.run(
                ["git", "cat-file", "--batch-check=%(objecttype) %(objectsize)"],
                cwd=root,
                input=object_id + "\n",
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired):
            finding = ("git-history-metadata-unavailable", relative, 0)
            if finding not in seen:
                seen.add(finding)
                findings.append(finding)
            continue
        metadata = metadata_result.stdout.strip().split()
        if metadata_result.returncode != 0 or len(metadata) != 2:
            finding = ("git-history-metadata-unavailable", relative, 0)
            if finding not in seen:
                seen.add(finding)
                findings.append(finding)
            continue
        object_type, raw_size = metadata
        if object_type == "tree":
            continue
        if object_type not in {"blob", "tag"}:
            finding = ("git-history-object-type-unsupported", relative, 0)
            if finding not in seen:
                seen.add(finding)
                findings.append(finding)
            continue
        try:
            blob_size = int(raw_size)
        except ValueError:
            blob_size = -1
        if blob_size < 0:
            finding = ("git-history-metadata-unavailable", relative, 0)
            if finding not in seen:
                seen.add(finding)
                findings.append(finding)
            continue
        history_path = (
            Path("refs") / "tags" / relative
            if object_type == "tag"
            else relative
        )
        if blob_size > MAX_FILE_BYTES:
            rule = (
                "oversize-historical-tag"
                if object_type == "tag"
                else "oversize-historical-blob"
            )
            finding = (rule, history_path, 0)
            if finding not in seen:
                seen.add(finding)
                findings.append(finding)
            continue
        try:
            blob = subprocess.run(
                ["git", "cat-file", object_type, object_id],
                cwd=root,
                check=False,
                capture_output=True,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired):
            finding = ("git-history-read-unavailable", history_path, 0)
            if finding not in seen:
                seen.add(finding)
                findings.append(finding)
            continue
        if blob.returncode != 0:
            finding = ("git-history-read-unavailable", history_path, 0)
            if finding not in seen:
                seen.add(finding)
                findings.append(finding)
            continue
        try:
            text = blob.stdout.decode("utf-8")
        except UnicodeDecodeError:
            blob_findings = list(scan_binary_metadata(blob.stdout, history_path))
            if object_type == "tag":
                blob_findings.append(("non-utf8-historical-tag", history_path, 0))
            elif relative.suffix.lower() not in REVIEWED_BINARY_ASSET_SUFFIXES:
                blob_findings.append(("non-utf8-historical-blob", relative, 0))
        else:
            blob_findings = scan_text(text, history_path)
        for finding in blob_findings:
            if finding not in seen:
                seen.add(finding)
                findings.append(finding)
    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument(
        "--history",
        action="store_true",
        help="also scan every blob reachable from the current Git refs",
    )
    args = parser.parse_args()
    root = Path(args.root).resolve()
    if not self_check():
        print("public-boundary check failed: scanner-self-check")
        return 1
    findings = scan(root)
    if args.history:
        findings.extend(scan_history(root))
    findings = sorted(set(findings), key=lambda item: (str(item[1]), item[2], item[0]))
    if findings:
        print(f"public-boundary check failed: {len(findings)} finding(s)")
        for rule, path, line in findings:
            print(f"{rule}: {path}:{line}")
        return 1
    print("public-boundary check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
