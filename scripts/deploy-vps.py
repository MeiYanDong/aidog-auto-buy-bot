from __future__ import annotations

import os
import posixpath
import shlex
import sys
import time
from pathlib import Path

import paramiko


ROOT = Path(__file__).resolve().parents[1]
APP_NAME = "aidog-bot"
DEFAULT_DEPLOY_DIR = "/opt/aidog-bot"
DEFAULT_SERVICE_NAME = "aidog-bot.service"
DEFAULT_APP_USER = "aidogbot"
REMOTE_ENV_FILTER_PREFIXES = ("SERVER_",)
REMOTE_ENV_FILTER_LINES = {"# 服务器配置"}
LOCAL_FILE_NAMES = {".env.example", ".gitignore", "package.json", "package-lock.json"}
LOCAL_DIR_NAMES = {"deploy", "docs", "scripts"}


def main() -> int:
    env_map = load_env_map(ROOT / ".env")
    server_ip = require_env(env_map, "SERVER_IP")
    server_password = require_env(env_map, "SERVER_PASSWORD")
    server_user = env_map.get("SERVER_USER") or "root"

    deploy_dir = env_map.get("DEPLOY_DIR") or DEFAULT_DEPLOY_DIR
    service_name = env_map.get("DEPLOY_SERVICE_NAME") or DEFAULT_SERVICE_NAME
    app_user = env_map.get("DEPLOY_APP_USER") or DEFAULT_APP_USER
    runtime_node = posixpath.join(deploy_dir, ".runtime/node/bin/node")

    print(f"Connecting to {server_ip} as {server_user}...")
    client = connect(server_ip, server_user, server_password)
    try:
        ensure_remote_safe(client, deploy_dir)

        print(f"Ensuring isolated app user {app_user}...")
        run_checked(
            client,
            "\n".join(
                [
                    "set -euo pipefail",
                    f"if ! id -u {shell_quote(app_user)} >/dev/null 2>&1; then",
                    (
                        "  useradd --system --home-dir "
                        f"{shell_quote(deploy_dir)} --shell /usr/sbin/nologin {shell_quote(app_user)}"
                    ),
                    "fi",
                    (
                        "mkdir -p "
                        + " ".join(
                            shell_quote(item)
                            for item in [
                                deploy_dir,
                                posixpath.join(deploy_dir, ".runtime"),
                                posixpath.join(deploy_dir, "data/logs"),
                                posixpath.join(deploy_dir, "data/state"),
                            ]
                        )
                    ),
                ],
            ),
        )

        print("Installing dedicated Node.js 20 runtime...")
        node_version = install_node_runtime(client, deploy_dir, runtime_node)
        print(f"Remote runtime ready: {node_version}")

        print("Uploading project files...")
        upload_project_files(client, deploy_dir)
        upload_remote_env(client, deploy_dir)
        upload_service_file(client, service_name, deploy_dir, app_user, runtime_node)

        print("Installing npm dependencies...")
        run_checked(
            client,
            "\n".join(
                [
                    "set -euo pipefail",
                    f"cd {shell_quote(deploy_dir)}",
                    f"export PATH={shell_quote(posixpath.join(deploy_dir, '.runtime/node/bin'))}:$PATH",
                    f"{shell_quote(runtime_node)} -v",
                    f"{shell_quote(posixpath.join(deploy_dir, '.runtime/node/bin/npm'))} ci --omit=dev",
                ],
            ),
            timeout=900,
        )

        print("Applying ownership and restarting service...")
        run_checked(
            client,
            "\n".join(
                [
                    "set -euo pipefail",
                    f"chown -R {shell_quote(app_user)}:{shell_quote(app_user)} {shell_quote(deploy_dir)}",
                    f"chmod 600 {shell_quote(posixpath.join(deploy_dir, '.env'))}",
                    f"systemctl daemon-reload",
                    f"systemctl enable --now {shell_quote(service_name)}",
                ],
            ),
            timeout=240,
        )

        print("Waiting for service to stabilize...")
        time.sleep(6)
        status = collect_status(client, service_name)
        print_status(status, service_name, deploy_dir, app_user, node_version)
    finally:
        client.close()

    return 0


def load_env_map(path: Path) -> dict[str, str]:
    if not path.exists():
        raise SystemExit(f"Missing {path}")

    result: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = strip_inline_env_comment(value.strip())
        result[key] = strip_wrapping_quotes(value)
    return result


def strip_wrapping_quotes(value: str) -> str:
    if len(value) >= 2 and ((value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'"))):
        return value[1:-1]
    return value


def strip_inline_env_comment(raw_value: str) -> str:
    in_single_quote = False
    in_double_quote = False

    for i, char in enumerate(raw_value):
        if char == "'" and not in_double_quote:
            in_single_quote = not in_single_quote
            continue
        if char == '"' and not in_single_quote:
            in_double_quote = not in_double_quote
            continue
        if not in_single_quote and not in_double_quote and char == "#" and i > 0 and raw_value[i - 1].isspace():
            return raw_value[:i].rstrip()

    return raw_value


def require_env(env_map: dict[str, str], key: str) -> str:
    value = env_map.get(key, "").strip()
    if not value:
        raise SystemExit(f"Missing required key in .env: {key}")
    return value


def connect(host: str, username: str, password: str) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=username, password=password, timeout=20)
    return client


def ensure_remote_safe(client: paramiko.SSHClient, deploy_dir: str) -> None:
    check_script = "\n".join(
        [
            "set -euo pipefail",
            f"if [ -e {shell_quote(deploy_dir)} ] && [ ! -d {shell_quote(deploy_dir)} ]; then",
            f"  echo {shell_quote(deploy_dir + ' exists but is not a directory')} >&2",
            "  exit 1",
            "fi",
            f"if [ -f {shell_quote(posixpath.join(deploy_dir, 'package.json'))} ]; then",
            (
                "  python3 - <<'PY'\n"
                f"import json\n"
                f"with open({deploy_dir!r} + '/package.json', 'r', encoding='utf-8') as fh:\n"
                "    data = json.load(fh)\n"
                "name = data.get('name', '')\n"
                "assert name == 'okx-onchainos-aidog', 'Unexpected package name in existing deploy dir: ' + name\n"
                "PY"
            ),
            "fi",
        ],
    )
    run_checked(client, check_script)


def install_node_runtime(client: paramiko.SSHClient, deploy_dir: str, runtime_node: str) -> str:
    runtime_root = posixpath.join(deploy_dir, ".runtime")
    command = "\n".join(
        [
            "set -euo pipefail",
            f"RUNTIME_ROOT={shell_quote(runtime_root)}",
            f"RUNTIME_NODE={shell_quote(runtime_node)}",
            'if [ ! -x "$RUNTIME_NODE" ] || ! "$RUNTIME_NODE" -v | grep -Eq \'^v20\\.\'; then',
            '  ARCHIVE_NAME=$(curl -fsSL https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt | awk \'/linux-x64.tar.xz$/ { print $2; exit }\')',
            '  TEMP_ARCHIVE="/tmp/$ARCHIVE_NAME"',
            '  rm -f "$TEMP_ARCHIVE"',
            '  curl -fsSL "https://nodejs.org/dist/latest-v20.x/$ARCHIVE_NAME" -o "$TEMP_ARCHIVE"',
            '  EXTRACTED_DIR="${ARCHIVE_NAME%.tar.xz}"',
            '  rm -rf "$RUNTIME_ROOT/$EXTRACTED_DIR" "$RUNTIME_ROOT/node"',
            '  tar -xJf "$TEMP_ARCHIVE" -C "$RUNTIME_ROOT"',
            '  mv "$RUNTIME_ROOT/$EXTRACTED_DIR" "$RUNTIME_ROOT/node"',
            '  rm -f "$TEMP_ARCHIVE"',
            "fi",
            '"$RUNTIME_NODE" -v',
        ],
    )
    stdout = run_checked(client, command, timeout=900)
    return stdout.strip().splitlines()[-1]


def upload_project_files(client: paramiko.SSHClient, deploy_dir: str) -> None:
    sftp = client.open_sftp()
    try:
        for local_path in iter_project_files():
            relative = local_path.relative_to(ROOT).as_posix()
            remote_path = posixpath.join(deploy_dir, relative)
            mkdir_p(sftp, posixpath.dirname(remote_path))
            sftp.put(str(local_path), remote_path)
    finally:
        sftp.close()


def upload_remote_env(client: paramiko.SSHClient, deploy_dir: str) -> None:
    local_env_path = ROOT / ".env"
    lines: list[str] = []
    for raw_line in local_env_path.read_text(encoding="utf-8").splitlines():
        stripped = raw_line.strip()
        if stripped in REMOTE_ENV_FILTER_LINES:
            continue
        if any(stripped.startswith(prefix) for prefix in REMOTE_ENV_FILTER_PREFIXES):
            continue
        lines.append(raw_line)

    content = "\n".join(lines).strip() + "\n"
    write_remote_text(client, posixpath.join(deploy_dir, ".env"), content)


def upload_service_file(
    client: paramiko.SSHClient,
    service_name: str,
    deploy_dir: str,
    app_user: str,
    runtime_node: str,
) -> None:
    service_content = render_service_file(service_name, deploy_dir, app_user, runtime_node)
    write_remote_text(client, posixpath.join("/etc/systemd/system", service_name), service_content)


def render_service_file(service_name: str, deploy_dir: str, app_user: str, runtime_node: str) -> str:
    _ = service_name
    return (
        "[Unit]\n"
        "Description=AIDOG auto-buy bot\n"
        "After=network-online.target\n"
        "Wants=network-online.target\n"
        "\n"
        "[Service]\n"
        "Type=simple\n"
        f"User={app_user}\n"
        f"Group={app_user}\n"
        f"WorkingDirectory={deploy_dir}\n"
        f"EnvironmentFile={deploy_dir}/.env\n"
        f"ExecStart={runtime_node} {deploy_dir}/scripts/aidog-auto-buy.mjs\n"
        "Restart=always\n"
        "RestartSec=10\n"
        "Environment=NODE_ENV=production\n"
        f"Environment=HOME={deploy_dir}\n"
        "UMask=0077\n"
        "NoNewPrivileges=true\n"
        "PrivateTmp=true\n"
        "ProtectHome=true\n"
        "ProtectSystem=strict\n"
        f"ReadWritePaths={deploy_dir}/data\n"
        "StandardOutput=journal\n"
        "StandardError=journal\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )


def iter_project_files() -> list[Path]:
    files: list[Path] = []

    for entry in sorted(ROOT.iterdir(), key=lambda item: item.name):
        if entry.name == ".env":
            continue
        if entry.name in LOCAL_FILE_NAMES and entry.is_file():
            files.append(entry)
            continue
        if entry.name in LOCAL_DIR_NAMES and entry.is_dir():
            for child in sorted(entry.rglob("*")):
                if child.is_file():
                    files.append(child)

    return files


def mkdir_p(sftp: paramiko.SFTPClient, remote_dir: str) -> None:
    if not remote_dir or remote_dir == "/":
        return

    parts = remote_dir.split("/")
    current = ""
    for part in parts:
        if not part:
            current = "/"
            continue
        current = posixpath.join(current, part) if current != "/" else f"/{part}"
        try:
            sftp.stat(current)
        except OSError:
            sftp.mkdir(current)


def write_remote_text(client: paramiko.SSHClient, remote_path: str, content: str) -> None:
    sftp = client.open_sftp()
    try:
        mkdir_p(sftp, posixpath.dirname(remote_path))
        with sftp.open(remote_path, "w") as remote_file:
            remote_file.write(content)
    finally:
        sftp.close()


def collect_status(client: paramiko.SSHClient, service_name: str) -> dict[str, str]:
    commands = {
        "active": f"systemctl is-active {shell_quote(service_name)} || true",
        "enabled": f"systemctl is-enabled {shell_quote(service_name)} || true",
        "status": f"systemctl status {shell_quote(service_name)} --no-pager -n 20 || true",
        "journal": f"journalctl -u {shell_quote(service_name)} --no-pager -n 20 || true",
        "monitor_service": "systemctl is-active aidog-price-monitor.service || true",
    }
    result: dict[str, str] = {}
    for key, command in commands.items():
        result[key] = run_checked(client, command, timeout=120, check=False).strip()
    return result


def print_status(
    status: dict[str, str],
    service_name: str,
    deploy_dir: str,
    app_user: str,
    node_version: str,
) -> None:
    print("")
    print("Deployment complete.")
    print(f"Service: {service_name}")
    print(f"Directory: {deploy_dir}")
    print(f"Run user: {app_user}")
    print(f"Node runtime: {node_version}")
    print(f"Service active: {status.get('active', '<unknown>')}")
    print(f"Service enabled: {status.get('enabled', '<unknown>')}")
    print(f"Existing monitor still active: {status.get('monitor_service', '<unknown>')}")
    print("")
    print("Recent service status:")
    print(status.get("status", ""))
    print("")
    print("Recent logs:")
    print(status.get("journal", ""))


def run_checked(
    client: paramiko.SSHClient,
    command: str,
    *,
    timeout: int = 120,
    check: bool = True,
) -> str:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    stdout_text = stdout.read().decode("utf-8", "replace")
    stderr_text = stderr.read().decode("utf-8", "replace")
    exit_code = stdout.channel.recv_exit_status()
    if check and exit_code != 0:
        raise SystemExit(
            "Remote command failed with exit code "
            f"{exit_code}\nSTDOUT:\n{stdout_text}\nSTDERR:\n{stderr_text}"
        )
    return stdout_text if stdout_text.strip() else stderr_text


def shell_quote(value: str) -> str:
    return shlex.quote(value)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        sys.exit(130)
