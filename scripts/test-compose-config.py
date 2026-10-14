#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Exercise Compose interpolation without a daemon or the user's .env."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "deploy" / "compose"


def main():
    # Do not inherit COMPOSE_FILE, profiles, credentials, or other overrides.
    env = {key: os.environ[key] for key in ("PATH", "HOME", "DOCKER_CONFIG")
           if key in os.environ}
    env.update(POSTGRES_PASSWORD="compose-test-postgres",
               JWT_SECRET="compose-test-secret-at-least-32-characters",
               BETTER_AUTH_URL="http://localhost:3010")
    with tempfile.TemporaryDirectory(prefix="baalda-compose-test-") as temp:
        empty_env = Path(temp) / ".env"
        empty_env.touch()

        def config(optional=False, values=None):
            command = ["docker", "compose", "--env-file", str(empty_env),
                       "-f", str(COMPOSE / "docker-compose.yml")]
            if optional:
                command += ["-f", str(COMPOSE / "docker-compose.minio.yml")]
            return subprocess.run(command + ["config", "--format", "json"],
                                  env={**env, **(values or {})}, cwd=temp,
                                  capture_output=True, text=True, timeout=30)

        base = config()
        assert base.returncode == 0, base.stderr
        data = json.loads(base.stdout)
        assert set(data["services"]) == {"postgres", "migrate", "server"}
        assert set(data["volumes"]) == {"baalda_pgdata"}
        assert data["services"]["server"]["environment"].get("BLOB_STORAGE", "postgres") == "postgres"
        print("PASS: default PostgreSQL stack needs no MinIO credentials")

        valid = {"MINIO_ROOT_USER": "compose-test-user",
                 "MINIO_ROOT_PASSWORD": "compose-test-password"}
        for key in valid:
            for empty in (False, True):
                values = dict(valid)
                if empty:
                    values[key] = ""
                else:
                    del values[key]
                failed = config(True, values)
                assert failed.returncode != 0, f"Expected rejection: {key}"
                assert key in failed.stderr, failed.stderr
        print("PASS: optional MinIO rejects each missing or empty credential")

        enabled = config(True, valid)
        assert enabled.returncode == 0, enabled.stderr
        data = json.loads(enabled.stdout)
        assert set(data["services"]) == {"postgres", "migrate", "server", "minio"}
        assert set(data["volumes"]) == {"baalda_pgdata", "baalda_minio"}
        assert data["services"]["minio"]["environment"] == valid
        assert data["services"]["minio"].get("profiles", []) == []
        print("PASS: explicit MinIO file enables the service with valid credentials")


if __name__ == "__main__":
    main()
