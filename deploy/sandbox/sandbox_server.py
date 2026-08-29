# The Potion code sandbox (X1, 2026-08-28) — a deliberately tiny stdlib-only
# HTTP service that executes ONE Python snippet per request inside a fresh,
# resource-capped, throwaway working directory, and returns stdout/stderr and
# any files the code produced.
#
# The isolation LAYERS (each stated in the machinery view; none oversold):
#   · network: the container sits on an INTERNAL-only docker network with no
#     egress — even stdlib sockets have nowhere to go (enforced by compose,
#     not by this file);
#   · identity: the container runs as a non-root user (Dockerfile USER);
#   · resources: per-exec address-space cap, CPU-seconds cap, process cap
#     (setrlimit in the child), plus a wall-clock kill from the parent;
#   · filesystem: each exec gets a fresh tmpdir, wiped afterward; input and
#     output files are size- and count-capped both ways.
# This is container isolation, not VM-grade multi-tenancy — honest for a
# single-tenant deploy, revisited before multi-tenant scale.
import base64
import json
import os
import resource
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SANDBOX_PORT", "8790"))
DEFAULT_TIMEOUT_S = 30
MAX_TIMEOUT_S = 120
MAX_CODE_BYTES = 256 * 1024
MAX_INPUT_FILES = 16
MAX_INPUT_TOTAL = 20 * 1024 * 1024
MAX_OUTPUT_FILES = 16
MAX_OUTPUT_FILE = 8 * 1024 * 1024
MAX_OUTPUT_TOTAL = 20 * 1024 * 1024
MAX_STREAM_BYTES = 64 * 1024  # stdout/stderr each, truncated with a marker
RLIMIT_AS_BYTES = 768 * 1024 * 1024
RLIMIT_CPU_S = 60
RLIMIT_NPROC = 64


def child_limits():
    # Each limit is best-effort: they all apply on the Linux prod container;
    # macOS dev refuses some (notably RLIMIT_AS). The wall-clock kill in the
    # parent is the backstop that holds everywhere.
    for lim, val in (
        (resource.RLIMIT_AS, RLIMIT_AS_BYTES),
        (resource.RLIMIT_CPU, RLIMIT_CPU_S),
        (resource.RLIMIT_NPROC, RLIMIT_NPROC),
    ):
        try:
            resource.setrlimit(lim, (val, val))
        except (ValueError, OSError):
            pass
    os.setsid()  # own process group so a timeout kill reaps grandchildren


def safe_name(name):
    # Workspace names are flat: no separators, no dotfiles, no traversal.
    if not name or len(name) > 120 or name.startswith("."):
        return None
    if any(c in name for c in ("/", "\\", "\x00")):
        return None
    return name


def run_exec(payload):
    code = payload.get("code")
    if not isinstance(code, str) or not code.strip():
        return {"error": "code (a non-empty string) is required"}
    if len(code.encode("utf-8")) > MAX_CODE_BYTES:
        return {"error": f"code exceeds {MAX_CODE_BYTES} bytes"}
    timeout_s = payload.get("timeoutSeconds", DEFAULT_TIMEOUT_S)
    if not isinstance(timeout_s, (int, float)) or not 1 <= timeout_s <= MAX_TIMEOUT_S:
        timeout_s = DEFAULT_TIMEOUT_S
    files = payload.get("files", [])
    if not isinstance(files, list) or len(files) > MAX_INPUT_FILES:
        return {"error": f"at most {MAX_INPUT_FILES} input files"}

    workdir = tempfile.mkdtemp(prefix="potion-exec-")
    try:
        total_in = 0
        for f in files:
            name = safe_name(f.get("name", ""))
            if name is None:
                return {"error": f"refused input file name: {f.get('name')!r}"}
            try:
                content = base64.b64decode(f.get("contentBase64", ""), validate=True)
            except Exception:
                return {"error": f"input file '{name}' is not valid base64"}
            total_in += len(content)
            if total_in > MAX_INPUT_TOTAL:
                return {"error": f"input files exceed {MAX_INPUT_TOTAL} bytes total"}
            with open(os.path.join(workdir, name), "wb") as fh:
                fh.write(content)
        before = set(os.listdir(workdir))
        script = os.path.join(workdir, "__potion_main__.py")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(code)
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": workdir,
            "MPLBACKEND": "Agg",
            "PYTHONUNBUFFERED": "1",
            "OPENBLAS_NUM_THREADS": "1",
            "OMP_NUM_THREADS": "1",
        }
        timed_out = False
        try:
            proc = subprocess.run(
                [sys.executable, "-I", script],
                cwd=workdir,
                env=env,
                capture_output=True,
                timeout=timeout_s,
                preexec_fn=child_limits,
            )
            exit_code = proc.returncode
            out, err = proc.stdout, proc.stderr
        except subprocess.TimeoutExpired as te:
            timed_out = True
            exit_code = -1
            out = te.stdout or b""
            err = (te.stderr or b"") + f"\n[potion sandbox] killed: wall clock exceeded {timeout_s}s".encode()

        def clip(b):
            text = b.decode("utf-8", errors="replace")
            if len(text) > MAX_STREAM_BYTES:
                return text[:MAX_STREAM_BYTES] + f"\n…[truncated at {MAX_STREAM_BYTES} chars]"
            return text

        out_files = []
        total_out = 0
        produced = sorted(set(os.listdir(workdir)) - before - {"__potion_main__.py"})
        for name in produced:
            path = os.path.join(workdir, name)
            if not os.path.isfile(path) or safe_name(name) is None:
                continue
            size = os.path.getsize(path)
            if size > MAX_OUTPUT_FILE:
                err = err + f"\n[potion sandbox] dropped '{name}': {size} bytes exceeds the {MAX_OUTPUT_FILE}-byte per-file cap".encode()
                continue
            if total_out + size > MAX_OUTPUT_TOTAL:
                err = err + f"\n[potion sandbox] dropped '{name}': output total would exceed {MAX_OUTPUT_TOTAL} bytes".encode()
                continue
            if len(out_files) >= MAX_OUTPUT_FILES:
                err = err + f"\n[potion sandbox] dropped '{name}': more than {MAX_OUTPUT_FILES} output files".encode()
                continue
            with open(path, "rb") as fh:
                out_files.append({"name": name, "size": size, "contentBase64": base64.b64encode(fh.read()).decode("ascii")})
            total_out += size
        return {
            "exitCode": exit_code,
            "timedOut": timed_out,
            "stdout": clip(out),
            "stderr": clip(err),
            "files": out_files,
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # no per-request noise; errors go to stderr
        pass

    def do_GET(self):
        if self.path == "/healthz":
            body = json.dumps({"ok": True, "python": sys.version.split()[0]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/exec":
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length > MAX_CODE_BYTES + MAX_INPUT_TOTAL * 2:
                raise ValueError("payload too large")
            payload = json.loads(self.rfile.read(length))
            result = run_exec(payload)
        except Exception as e:  # noqa: BLE001 — the sandbox must answer, not die
            result = {"error": f"sandbox request failed: {e}"}
        body = json.dumps(result).encode()
        self.send_response(400 if "error" in result else 200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"[potion sandbox] listening on :{PORT} (python {sys.version.split()[0]})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
