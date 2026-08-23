#!/usr/bin/env python3
"""Black-box negative cases for the public-boundary CLI."""

from __future__ import annotations

import runpy
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCANNER = ROOT / "scripts" / "check_public_boundary.py"


@dataclass(frozen=True)
class Case:
    name: str
    path: Path
    expected_rule: str
    payload: bytes


def _joined(*parts: str) -> str:
    return "".join(parts)


def _git(root: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )


def verify_annotated_tag_history(scanner_policy: dict[str, object]) -> bool:
    with tempfile.TemporaryDirectory(prefix="awp-boundary-tag-") as raw:
        fixture_root = Path(raw)
        allowances = scanner_policy["SEMANTIC_ALLOWANCES"]
        for relative in sorted({allowance.path for allowance in allowances}):
            source = ROOT / relative
            destination = fixture_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)

        _git(fixture_root, "init", "--quiet")
        _git(fixture_root, "config", "user.name", "AWP Boundary Test")
        _git(fixture_root, "config", "user.email", "boundary@example.invalid")
        _git(fixture_root, "add", ".")
        _git(fixture_root, "commit", "--quiet", "-m", "safe fixture")
        _git(fixture_root, "tag", "-a", "safe-v1", "-m", "safe release")

        safe_result = subprocess.run(
            [sys.executable, str(SCANNER), str(fixture_root), "--history"],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        if safe_result.returncode != 0:
            print("FAILED: safe annotated tag was rejected", file=sys.stderr)
            return False

        secret = _joined("sk", "-", "P" * 24)
        _git(fixture_root, "tag", "-a", "leak-v1", "-m", secret)
        leak_result = subprocess.run(
            [sys.executable, str(SCANNER), str(fixture_root), "--history"],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        normalized = leak_result.stdout.replace("\\", "/")
        marker = "openai-token-shape: refs/tags/leak-v1:"
        if leak_result.returncode != 1 or marker not in normalized:
            print("FAILED: annotated tag secret was not blocked", file=sys.stderr)
            return False
        if secret in leak_result.stdout:
            print("FAILED: scanner printed annotated tag secret", file=sys.stderr)
            return False
    return True


def main() -> int:
    scanner_policy = runpy.run_path(str(SCANNER))
    maximum = int(scanner_policy["MAX_FILE_BYTES"])
    cases = (
        Case(
            "policy source",
            Path("workflows/validation/validate_workflows.py"),
            "openai-token-shape",
            _joined("sk", "-", "P" * 24).encode(),
        ),
        Case(
            "test source",
            Path("tests/credential.spec.ts"),
            "legacy-brand",
            _joined("chip", "flow").encode(),
        ),
        Case(
            "synthetic database",
            Path("runtime/state.synthetic.db"),
            "runtime-data-filename",
            b"{}",
        ),
        Case(
            "synthetic opaque test fixture",
            Path("tests/document.synthetic.pdf"),
            "opaque-test-fixture-filename",
            b"%PDF-synthetic",
        ),
        Case(
            "non-UTF-8 payload",
            Path("fixtures/unreviewed.dat"),
            "non-utf8-unreviewed-file",
            bytes((255, 254, 0)),
        ),
        Case(
            "oversize payload",
            Path("fixtures/oversize.txt"),
            "oversize-unscanned-file",
            b"A" * (maximum + 1),
        ),
        Case(
            "ignored dist payload",
            Path("apps/desktop/dist/generated.js"),
            "legacy-brand",
            _joined("amp", "copilot").encode(),
        ),
        Case(
            "packaged executable",
            Path("release/agent.exe"),
            "packaged-binary-filename",
            b"MZ synthetic",
        ),
        Case(
            "specialized camel identifier",
            Path("apps/desktop/src/locales/example.json"),
            "specialized-design-domain",
            _joined('{"p', 'dkValid":true}').encode(),
        ),
        Case(
            "retired commercial source",
            Path("apps/desktop/src/router/example.ts"),
            "retired-commercial-content",
            _joined("const invite", "Code = 'local-example'").encode(),
        ),
        Case(
            "minified dist commercial payload",
            Path("apps/desktop/dist/assets/example.min.js"),
            "retired-commercial-content",
            _joined("(()=>{const x={goToBil", "ling:'Top ", "Up'}})();").encode(),
        ),
        Case(
            "retired model cost field",
            Path("apps/desktop/src/api/model-example.ts"),
            "retired-commercial-content",
            _joined("input_pr", "ice_per_1k?: number").encode(),
        ),
        Case(
            "retired account monetary field",
            Path("apps/desktop/scripts/auth-example.mjs"),
            "retired-commercial-content",
            _joined("{ bal", "ance: 0 }").encode(),
        ),
        Case(
            "retired schematic preview identifier",
            Path("apps/desktop/electron/service-example.ts"),
            "specialized-design-domain",
            _joined("render_schem", "atic_preview").encode(),
        ),
        Case(
            "retired bare schematic renderer identifier",
            Path("apps/desktop/electron/semantic-example.ts"),
            "specialized-design-domain",
            _joined("render_schem", "atic").encode(),
        ),
        Case(
            "retired specialized list identifiers",
            Path("apps/desktop/electron/list-example.ts"),
            "specialized-design-domain",
            _joined("net", "list_scs;leftover net", "lists").encode(),
        ),
        Case(
            "specialized UI and feedback identifiers",
            Path("apps/desktop/src/components/example.ts"),
            "specialized-design-domain",
            _joined(
                "waveform", "Viewer;bode", "Mode;analog ", "circuit;",
                "simulation_", "bug"
            ).encode(),
        ),
        Case(
            "localized commercial content",
            Path("apps/desktop/src/locales/fixture.json"),
            "retired-commercial-content",
            _joined('{"action":"\u5145', '\u503c"}').encode(),
        ),
        Case(
            "internal customer incident identity",
            Path("apps/desktop/src/incident-example.ts"),
            "internal-customer-incident",
            _joined("cus", "tomer Ac", "me incident 2026-08-22").encode(),
        ),
        Case(
            "retired space-split CLI override",
            Path("apps/desktop/e2e/cli-example.ts"),
            "retired-cli-override",
            _joined("AWP_CC_CLI_", "OVERRIDE=node agent.js").encode(),
        ),
        Case(
            "disabled SSH host-key verification",
            Path("apps/desktop/electron/ssh-example.ts"),
            "insecure-ssh-host-key-policy",
            _joined("StrictHostKey", "Checking=no").encode(),
        ),
        Case(
            "machine-specific numeric drive path",
            Path("apps/desktop/electron/path-example.ts"),
            "machine-specific-drive-path",
            _joined("D:\\", "111\\vmrun.exe").encode(),
        ),
        Case(
            "private network fallback host",
            Path("apps/desktop/electron/connection-example.ts"),
            "private-network-endpoint",
            _joined(
                "const sshHost = process.env.AWP_LAB_HOST || 'user@10.",
                "9.8.7'",
            ).encode(),
        ),
        Case(
            "retired synchronous agent route",
            Path("apps/desktop/electron/agent-example.ts"),
            "retired-hosted-route",
            _joined("/v1/agent/", "status").encode(),
        ),
        Case(
            "retired support upload route",
            Path("apps/desktop/electron/support-example.ts"),
            "retired-hosted-route",
            _joined("/v1/support/diagnostic/upl", "oad").encode(),
        ),
        Case(
            "retired loopback documentation route",
            Path("apps/desktop/src/docs-example.ts"),
            "retired-hosted-route",
            _joined("http://127.0.0.1:87", "87/docs/troubleshooting").encode(),
        ),
        Case(
            "retired hosted route",
            Path("apps/desktop/src/route-example.ts"),
            "retired-hosted-route",
            _joined("/v1/remote/", "diag/", "pending").encode(),
        ),
        Case(
            "retired trace upload route",
            Path("apps/desktop/electron/trace-example.ts"),
            "retired-hosted-route",
            _joined("/v1/trace/upl", "oad").encode(),
        ),
        Case(
            "retired binary rebrand narrative",
            Path("apps/desktop/scripts/build-example.mjs"),
            "retired-internal-product-narrative",
            _joined("daemon (renamed ", "CC)").encode(),
        ),
        Case(
            "retired customer telemetry policy",
            Path("apps/desktop/electron/telemetry-example.ts"),
            "retired-internal-product-narrative",
            _joined("feedback_cus", "tomer-data-must-flow-to-cloud").encode(),
        ),
        Case(
            "retired specialized public asset",
            Path("apps/desktop/public/layout_preview.svg"),
            "specialized-design-domain-name",
            b"<svg/>",
        ),
        Case(
            "retired specialized source basename",
            Path("apps/desktop/src/utils/autoRouter.ts"),
            "specialized-design-domain-name",
            b"export {}",
        ),
        Case(
            "retired commercial release note",
            Path("apps/desktop/RELEASE-NOTES-v1.5.0.md"),
            "retired-release-note-name",
            b"# Archived fixture",
        ),
    )

    with tempfile.TemporaryDirectory(prefix="awp-boundary-negative-") as raw:
        fixture_root = Path(raw)
        allowances = scanner_policy["SEMANTIC_ALLOWANCES"]
        for relative in sorted({allowance.path for allowance in allowances}):
            source = ROOT / relative
            destination = fixture_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)

        for case in cases:
            target = fixture_root / case.path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(case.payload)

        result = subprocess.run(
            [sys.executable, str(SCANNER), str(fixture_root)],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        if result.returncode != 1:
            print(
                f"FAILED: boundary CLI returned {result.returncode}, expected 1",
                file=sys.stderr,
            )
            return 1
        normalized = result.stdout.replace("\\", "/")
        for case in cases:
            marker = f"{case.expected_rule}: {case.path.as_posix()}:"
            if marker not in normalized:
                print(
                    f"FAILED: negative case was not blocked: {case.name}",
                    file=sys.stderr,
                )
                return 1
            try:
                rendered_payload = case.payload.decode("utf-8")
            except UnicodeDecodeError:
                rendered_payload = ""
            if rendered_payload and rendered_payload in result.stdout:
                print(
                    f"FAILED: scanner printed fixture content: {case.name}",
                    file=sys.stderr,
                )
                return 1

    if not verify_annotated_tag_history(scanner_policy):
        return 1

    print(
        f"boundary fail-closed negative cases passed: {len(cases)}/{len(cases)} "
        "+ annotated tag history"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
