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
import hashlib
import json
import os
import re
import resource
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# LIVE OUTPUT (2026-09-02, Live views #2): while an exec runs, its stdout/
# stderr accumulate here under the caller-chosen execId so GET /tail/<id>
# can show work in progress — a 90-second computation should read as work,
# not a hang. The durable record stays the completed step; this is the
# ephemeral now. Entries die with their exec.
LIVE = {}
LIVE_LOCK = threading.Lock()
LIVE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

PORT = int(os.environ.get("SANDBOX_PORT", "8790"))
DEFAULT_TIMEOUT_S = 30
MAX_TIMEOUT_S = 120
MAX_CODE_BYTES = 256 * 1024
MAX_INPUT_FILES = 400
MAX_INPUT_TOTAL = 64 * 1024 * 1024
MAX_OUTPUT_FILES = 400
MAX_OUTPUT_FILE = 8 * 1024 * 1024
MAX_OUTPUT_TOTAL = 64 * 1024 * 1024
MAX_STREAM_BYTES = 64 * 1024  # stdout/stderr each, truncated with a marker
RLIMIT_AS_BYTES = 768 * 1024 * 1024
RLIMIT_CPU_S = 60
RLIMIT_NPROC = 64


def child_limits():
    # Each limit is best-effort: they all apply on the Linux prod container;
    # macOS dev refuses some (notably RLIMIT_AS), and NPROC is skipped there
    # outright — Darwin counts it PER USER, so a dev machine's hundreds of
    # processes make bash unable to fork at all (X7 found this via the
    # shell). The wall-clock kill in the parent holds everywhere.
    limits = [
        (resource.RLIMIT_AS, RLIMIT_AS_BYTES),
        (resource.RLIMIT_CPU, RLIMIT_CPU_S),
    ]
    if sys.platform != "darwin":
        limits.append((resource.RLIMIT_NPROC, RLIMIT_NPROC))
    for lim, val in limits:
        try:
            resource.setrlimit(lim, (val, val))
        except (ValueError, OSError):
            pass
    os.setsid()  # own process group so a timeout kill reaps grandchildren


SEGMENT_OK = __import__("re").compile(r"^[A-Za-z0-9._-]{1,120}$")


def safe_relpath(name):
    # X7 workspace v2: '/'-separated relative TREES. Dotfiles allowed (dev
    # repos need them); traversal ('.', '..'), '.git', empty/hostile
    # segments and absolute paths are not. Mirrors the storage boundary's
    # validRunFilePath — defense in depth, not trust.
    if not isinstance(name, str) or not name or len(name) > 240:
        return None
    if name.startswith("/") or name.endswith("/") or "\\" in name or "\x00" in name:
        return None
    segments = name.split("/")
    if len(segments) > 12:
        return None
    for seg in segments:
        if seg in (".", "..", ".git") or not SEGMENT_OK.match(seg):
            return None
    return name


def run_exec(payload):
    # X7: the SEALED SHELL — same tmpdir, same rlimits, same wall-clock
    # kill, same no-egress network law as python. A terminal that provably
    # cannot phone home is safe by construction; git and node live in the
    # image and work fully offline.
    mode = payload.get("mode", "python")
    if mode not in ("python", "shell"):
        return {"error": "mode must be python or shell"}
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
            name = safe_relpath(f.get("name", ""))
            if name is None:
                return {"error": f"refused input file name: {f.get('name')!r}"}
            try:
                content = base64.b64decode(f.get("contentBase64", ""), validate=True)
            except Exception:
                return {"error": f"input file '{name}' is not valid base64"}
            total_in += len(content)
            if total_in > MAX_INPUT_TOTAL:
                return {"error": f"input files exceed {MAX_INPUT_TOTAL} bytes total"}
            dest = os.path.join(workdir, name)
            # Belt on the validated path: the resolved parent stays inside.
            if not os.path.realpath(dest).startswith(os.path.realpath(workdir) + os.sep):
                return {"error": f"refused input file path: {name!r}"}
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as fh:
                fh.write(content)

        def walk_files():
            found = []
            for root, dirs, names in os.walk(workdir):
                dirs[:] = [d for d in dirs if d != ".git"]
                for n in names:
                    path = os.path.join(root, n)
                    if os.path.islink(path):
                        continue
                    rel = os.path.relpath(path, workdir)
                    found.append(rel.replace(os.sep, "/"))
            return set(found)

        def snapshot():
            # Content hashes, not just names (2026-09-01, run-28a169d5): a
            # name-only "before" set silently DROPPED every rewrite of an
            # existing file — a worker regenerated a corrupted analysis.json
            # four times, stdout said "written OK" each time, and the
            # workspace kept the stale copy forever. Changed content is
            # produced output exactly like a new file.
            state = {}
            for rel in walk_files():
                path = os.path.join(workdir, rel)
                h = hashlib.sha256()
                try:
                    with open(path, "rb") as fh:
                        for chunk in iter(lambda: fh.read(1 << 20), b""):
                            h.update(chunk)
                except OSError:
                    continue
                state[rel] = h.hexdigest()
            return state

        before = snapshot()
        script = os.path.join(workdir, "__potion_main__.py" if mode == "python" else "__potion_main__.sh")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(code)
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": workdir,
            "GIT_AUTHOR_NAME": "potion-worker",
            "GIT_AUTHOR_EMAIL": "worker@potion.local",
            "GIT_COMMITTER_NAME": "potion-worker",
            "GIT_COMMITTER_EMAIL": "worker@potion.local",
            "MPLBACKEND": "Agg",
            # matplotlib caches its font list under HOME/.cache; HOME is the
            # collected workdir, so without this the cache pollutes the run's
            # ARTIFACTS. Point it at a fixed dir OUTSIDE the workdir (built
            # once, reused, never collected). 2026-08-31 flagship finding.
            "MPLCONFIGDIR": os.environ.get("POTION_MPLCONFIGDIR", "/tmp/potion-mplconfig"),
            "PYTHONUNBUFFERED": "1",
            "OPENBLAS_NUM_THREADS": "1",
            "OMP_NUM_THREADS": "1",
        }
        timed_out = False
        exec_id = payload.get("execId")
        live = None
        if isinstance(exec_id, str) and LIVE_ID_RE.match(exec_id):
            live = {"out": bytearray(), "err": bytearray(), "done": False}
            with LIVE_LOCK:
                LIVE[exec_id] = live
        try:
            argv = [sys.executable, "-I", script] if mode == "python" else ["bash", script]
            # Popen + reader threads instead of subprocess.run: the readers
            # append into the LIVE buffers as bytes arrive, so /tail sees
            # output mid-flight. The completed result reads the same buffers
            # — one source of truth for both the live view and the record.
            proc = subprocess.Popen(
                argv,
                cwd=workdir,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                preexec_fn=child_limits,
            )
            bufs = live if live is not None else {"out": bytearray(), "err": bytearray()}

            def reader(pipe, key):
                # read1: return WHATEVER is available (read(n) would block
                # until n bytes or EOF — the live buffers stayed empty).
                for chunk in iter(lambda: pipe.read1(4096), b""):
                    with LIVE_LOCK:
                        bufs[key] += chunk
                pipe.close()

            t_out = threading.Thread(target=reader, args=(proc.stdout, "out"), daemon=True)
            t_err = threading.Thread(target=reader, args=(proc.stderr, "err"), daemon=True)
            t_out.start()
            t_err.start()
            try:
                exit_code = proc.wait(timeout=timeout_s)
            except subprocess.TimeoutExpired:
                timed_out = True
                exit_code = -1
                proc.kill()
                proc.wait()
            t_out.join(timeout=5)
            t_err.join(timeout=5)
            with LIVE_LOCK:
                out = bytes(bufs["out"])
                err = bytes(bufs["err"])
            if timed_out:
                err += f"\n[potion sandbox] killed: wall clock exceeded {timeout_s}s".encode()
        finally:
            if live is not None:
                with LIVE_LOCK:
                    live["done"] = True
                    LIVE.pop(exec_id, None)

        def clip(b):
            text = b.decode("utf-8", errors="replace")
            if len(text) > MAX_STREAM_BYTES:
                return text[:MAX_STREAM_BYTES] + f"\n…[truncated at {MAX_STREAM_BYTES} chars]"
            return text

        out_files = []
        total_out = 0
        after = snapshot()
        produced = sorted(
            rel
            for rel, digest in after.items()
            if rel not in ("__potion_main__.py", "__potion_main__.sh") and before.get(rel) != digest
        )
        for name in produced:
            path = os.path.join(workdir, name)
            if not os.path.isfile(path) or os.path.islink(path) or safe_relpath(name) is None:
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

    def do_GET_tail(self):
        exec_id = self.path[len("/tail/"):]
        entry = None
        if LIVE_ID_RE.match(exec_id):
            with LIVE_LOCK:
                e = LIVE.get(exec_id)
                if e is not None:
                    entry = {
                        "stdout": bytes(e["out"]).decode("utf-8", errors="replace")[-MAX_STREAM_BYTES:],
                        "stderr": bytes(e["err"]).decode("utf-8", errors="replace")[-MAX_STREAM_BYTES:],
                        "done": e["done"],
                    }
        if entry is None:
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps(entry).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/tail/"):
            return self.do_GET_tail()
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
