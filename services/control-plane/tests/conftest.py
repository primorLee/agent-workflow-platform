from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CLOUD = ROOT / "cloud"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(CLOUD))

TEST_DIR = Path(tempfile.mkdtemp(prefix="awp-control-plane-tests-"))
os.environ["AWP_ENV"] = "test"
os.environ["AWP_DATA_DIR"] = str(TEST_DIR / "data")
os.environ["AWP_DATABASE_URL"] = str(TEST_DIR / "data" / "test.db")
os.environ["AWP_DEV_API_KEY"] = "test-only-control-plane-key-00000001"
os.environ["AWP_WS_BROKER"] = "memory"
os.environ["AWP_PROMETHEUS_ENABLED"] = "1"


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from server import app

    with TestClient(app) as test_client:
        yield test_client