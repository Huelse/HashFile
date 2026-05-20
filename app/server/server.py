#!/usr/bin/env python3
"""HashFile web server — serves static UI and /api/hash endpoint."""

import os
import json
import subprocess
import threading
from urllib.parse import urlparse, parse_qs
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get("service_port", 17743))
WWW_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "www")

ALGO_CMDS = {
    "sha256": "sha256sum",
    "md5":    "md5sum",
    "sha1":   "sha1sum",
    "sha512": "sha512sum",
}


def compute_hashes(path, algos, recursive, expected, sub_timeout=None):

    files = []
    if os.path.isfile(path):
        files = [path]
    elif os.path.isdir(path):
        if recursive:
            for root, dirs, names in os.walk(path):
                dirs.sort()
                for name in sorted(names):
                    files.append(os.path.join(root, name))
        else:
            files = sorted(
                os.path.join(path, f)
                for f in os.listdir(path)
                if os.path.isfile(os.path.join(path, f))
            )

    results = []
    for f in files:
        for a in algos:
            cmd = ALGO_CMDS.get(a)
            if not cmd:
                continue
            try:
                proc = subprocess.run(
                    [cmd, "--", f],
                    capture_output=True, text=True, timeout=sub_timeout
                )
                if proc.returncode == 0:
                    hash_val = proc.stdout.split()[0]
                    err = None
                else:
                    hash_val = None
                    err = proc.stderr.strip() or "hash command failed"
            except subprocess.TimeoutExpired:
                hash_val = None
                err = f"{cmd} timed out after {sub_timeout}s"
            except FileNotFoundError:
                hash_val = None
                err = f"command not found: {cmd}"

            entry = {"file": f, "algo": a, "hash": hash_val}
            if err:
                entry["error"] = err
            if expected:
                entry["verified"] = (hash_val == expected)
                entry["expected"] = expected
            results.append(entry)

    return results


class HashHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WWW_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/hash":
            self._handle_api(parsed)
        else:
            super().do_GET()

    def _handle_api(self, parsed):
        qs = parse_qs(parsed.query)
        path = qs.get("path", [""])[0].strip()
        algo_param = qs.get("algo", ["sha256"])[0].strip()
        recursive = qs.get("recursive", ["false"])[0].lower() == "true"
        expected = qs.get("expected", [""])[0].strip()

        if not path:
            return self._json({"success": False, "error": "path parameter is required"}, 400)
        if not os.path.exists(path):
            return self._json({"success": False, "error": f"Path not found: {path}"}, 404)

        if algo_param == "all":
            algos = list(ALGO_CMDS)
        else:
            algos = [a.strip() for a in algo_param.split(",") if a.strip() in ALGO_CMDS]
            if not algos:
                return self._json({"success": False, "error": f"No valid algorithm: {algo_param}"}, 400)

        raw_timeout = int(qs.get("timeout", ["60"])[0])
        sub_timeout = raw_timeout if raw_timeout > 0 else None

        try:
            results = compute_hashes(path, algos, recursive, expected, sub_timeout)
            self._json({"success": True, "path": path, "results": results})
        except Exception as exc:
            self._json({"success": False, "error": str(exc)}, 500)

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # quiet — errors only


if __name__ == "__main__":
    server = ThreadingHTTPServer(("", PORT), HashHandler)
    print(f"HashFile listening on :{PORT}", flush=True)
    server.serve_forever()
