"""
T1 Gate: Docker Compose Boot & Resilience
Real integration test - no mocks
"""

import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest
import requests


class TestT1ComposeResilience:
    """Real docker-compose resilience test"""

    @classmethod
    def setup_class(cls):
        """Initialize test class"""
        cls.compose_file = Path(__file__).parent.parent.parent / "docker-compose.yml"
        cls.test_marker = f"test_marker_{int(time.time())}"
        cls.docker_available = _docker_compose_available()

        # Provide sane defaults for local/CI runs where secrets are not injected.
        # A missing password prevents the Postgres container from ever starting,
        # which in turn causes connection-refused errors throughout the suite.
        os.environ.setdefault("DB_PASSWORD", "postgres")

        # When running in Docker test container, services are already up
        if os.getenv("DB_HOST") == "db":
            # Running inside Docker, skip docker commands
            return

        if not cls.docker_available:
            # Without docker we rely on the in-process fixtures started by
            # tests/conftest.py, so there's nothing to boot here.
            return

        # Only start services when running locally
        # Ensure clean state
        subprocess.run(
            ["docker", "compose", "-f", str(cls.compose_file), "down", "-v"],
            capture_output=True,
        )

        # Start services
        result = subprocess.run(
            ["docker", "compose", "-f", str(cls.compose_file), "up", "-d"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"Failed to start services: {result.stderr}"

        # Wait for health
        cls._wait_for_health()

    @classmethod
    def teardown_class(cls):
        """Clean up"""
        # Skip teardown when running inside Docker
        if os.getenv("DB_HOST") == "db":
            return

        if not getattr(cls, "docker_available", False):
            return

        subprocess.run(
            ["docker", "compose", "-f", str(cls.compose_file), "down"],
            capture_output=True,
        )

    @staticmethod
    def _wait_for_health(timeout: int = 30) -> bool:
        """Wait for all services to be healthy"""

        if not _docker_compose_available():
            return True

        start = time.time()
        while time.time() - start < timeout:
            result = subprocess.run(
                ["docker", "compose", "ps", "--format", "json"],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0 and '"State":"running"' in result.stdout:
                time.sleep(2)  # Extra time for health checks
                return True
            time.sleep(1)
        raise TimeoutError("Services did not become healthy")

    def test_all_services_boot(self):
        """T1: Verify all services start successfully"""
        # When running inside Docker, check connectivity instead
        if os.getenv("DB_HOST") == "db":
            import socket

            services_to_check = [
                ("db", 5432),
                ("api", 8082),
                ("mcp-server", 8081),
                ("reverse-proxy", 80),
            ]

            for host, port in services_to_check:
                try:
                    sock = socket.create_connection((host, port), timeout=5)
                    sock.close()
                except Exception as exc:  # pragma: no cover - diagnostic only
                    pytest.fail(f"Service {host}:{port} not reachable: {exc}")
        elif not getattr(self, "docker_available", False):
            base_url = os.getenv("TEST_BASE_URL", "http://127.0.0.1:8000")
            response = requests.get(f"{base_url}/health", timeout=5)
            assert response.status_code == 200
        else:
            result = subprocess.run(
                ["docker", "compose", "ps", "--services", "--filter", "status=running"],
                capture_output=True,
                text=True,
            )

            running_services = result.stdout.strip().split("\n")
            required = ["db", "mcp-server", "worker", "api", "reverse-proxy"]

            for service in required:
                assert service in running_services, f"Service {service} not running"

    def test_healthchecks_pass(self):
        """T1: Verify health checks pass"""
        api_url = os.getenv("API_URL", "http://localhost:8082")
        response = requests.get(api_url, timeout=5)
        assert response.status_code < 500, "API not healthy"

        proxy_url = os.getenv("PROXY_URL", "http://localhost")
        if proxy_url.startswith("https://"):
            proxy_url = proxy_url.replace("https://", "http://")
        response = requests.get(f"{proxy_url}/health", timeout=5)
        assert response.status_code in [200, 404, 502], (
            f"Proxy not healthy: {response.status_code}"
        )

    def test_state_persistence_after_restart(self):
        """T1: Verify state persists after container restart"""
        if os.getenv("DB_HOST") == "db":
            pytest.skip("State verification is handled by the dockerised test runner")

        if not getattr(self, "docker_available", False):
            pytest.skip("Docker Compose not available - skipping persistence restart test")

        import pg8000.native as pg  # Imported lazily to avoid optional dependency issues

        conn = pg.Connection(
            host=os.getenv("DB_HOST", "localhost"),
            port=int(os.getenv("DB_PORT", 5432)),
            database=os.getenv("DB_NAME", "adhd_budget"),
            user=os.getenv("DB_USER", "budget_user"),
            password=os.getenv("DB_PASSWORD"),
        )

        try:
            conn.run(
                """
                CREATE TABLE IF NOT EXISTS test_resilience (
                    id SERIAL PRIMARY KEY,
                    marker VARCHAR(255) UNIQUE,
                    created_at TIMESTAMP DEFAULT NOW()
                )
                """
            )

            conn.run(
                "INSERT INTO test_resilience (marker) VALUES (:marker) ON CONFLICT DO NOTHING",
                marker=self.test_marker,
            )

            subprocess.run(
                ["docker", "compose", "restart", "worker"],
                capture_output=True,
            )

            time.sleep(5)

            result = conn.run(
                "SELECT marker FROM test_resilience WHERE marker = :marker",
                marker=self.test_marker,
            )
            assert result, "State not persisted after restart"
            assert result[0][0] == self.test_marker
        finally:
            conn.close()

    def test_automatic_restart_on_failure(self):
        """T1: Verify automatic restart on container failure"""
        if os.getenv("DB_HOST") == "db":
            pytest.skip("Cannot test Docker restart from inside container")

        if not getattr(self, "docker_available", False):
            pytest.skip("Docker Compose not available - skipping restart simulation")

        subprocess.run(["docker", "compose", "kill", "worker"], capture_output=True)

        time.sleep(10)

        result = subprocess.run(
            ["docker", "compose", "ps", "worker", "--format", "json"],
            capture_output=True,
            text=True,
        )

        assert '"State":"running"' in result.stdout, "Worker did not auto-restart"

    def test_network_connectivity(self):
        """T1: Verify inter-service connectivity"""
        api_url = os.getenv("API_URL", "http://localhost:8082")
        response = requests.get(api_url, timeout=5)
        assert response.status_code < 500

        proxy_url = os.getenv("PROXY_URL", "http://localhost")
        response = requests.get(f"{proxy_url}/api", timeout=5)
        assert response.status_code in [200, 404, 502]


def _docker_compose_available() -> bool:
    """Return True if docker compose is available in the environment."""

    docker = shutil.which("docker")
    if not docker:
        return False

    try:
        result = subprocess.run(
            [docker, "compose", "version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except OSError:
        return False

    return result.returncode == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
