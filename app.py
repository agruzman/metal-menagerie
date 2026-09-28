"""
app.py — lets the shop run on a hosting service that was set up for Python.

The shop is a Node.js app (server.js). If the hosting service was created
with the Python runtime, its start command is something like
`gunicorn app:app` or `python app.py`. Both land here, and both end up
running the real Node app:

    python app.py        -> simply runs `node server.js` on $PORT
    gunicorn app:app     -> gunicorn listens on $PORT, starts `node server.js`
                            on an inner port and forwards every request to it

On a service created with the Node runtime this file is never used.
Uses only the Python standard library.
"""
import atexit
import http.client
import os
import socket
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
INNER_PORT = int(os.environ.get("SHOP_INNER_PORT", "3210"))
NODE_ENTRY = os.environ.get("SHOP_NODE_ENTRY", "server.js")

_node = None
_lock = threading.Lock()


def ensure_dependencies():
    """Installs node_modules if the build step did not (slow on a small box, but works)."""
    if os.path.isdir(os.path.join(ROOT, "node_modules", "express")):
        return
    print("[shim] node_modules missing — running npm install", flush=True)
    subprocess.check_call(
        ["npm", "install", "--omit=dev", "--no-audit", "--no-fund"], cwd=ROOT
    )


def start_node(port):
    """Starts `node server.js` on the given port (once) and keeps it running."""
    global _node
    with _lock:
        if _node is not None and _node.poll() is None:
            return _node
        ensure_dependencies()
        env = dict(os.environ, PORT=str(port))
        _node = subprocess.Popen(["node", NODE_ENTRY], cwd=ROOT, env=env)
        print(f"[shim] started node {NODE_ENTRY} on port {port} (pid {_node.pid})", flush=True)
        return _node


def supervise(port):
    """Restarts the Node process if it ever exits. Runs in a background thread."""
    while True:
        proc = start_node(port)
        code = proc.wait()
        print(f"[shim] node exited with code {code}; restarting in 2 s", flush=True)
        time.sleep(2)


def _stop_node():
    if _node is not None and _node.poll() is None:
        _node.terminate()


atexit.register(_stop_node)


def wait_for_port(port, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.25)
    return False


# Headers that describe the connection itself and must not be forwarded.
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}


def _request_headers(environ):
    headers = {}
    for key, value in environ.items():
        if key.startswith("HTTP_"):
            name = key[5:].replace("_", "-").title()
            if name.lower() not in _HOP_BY_HOP:
                headers[name] = value
    if environ.get("CONTENT_TYPE"):
        headers["Content-Type"] = environ["CONTENT_TYPE"]
    # Tell the Node app how the visitor reached us (it needs https for cookies).
    headers.setdefault("X-Forwarded-Proto", environ.get("wsgi.url_scheme", "http"))
    if environ.get("REMOTE_ADDR") and "X-Forwarded-For" not in headers:
        headers["X-Forwarded-For"] = environ["REMOTE_ADDR"]
    return headers


def _request_target(environ):
    raw = environ.get("RAW_URI") or environ.get("REQUEST_URI")
    if raw:
        return raw
    from urllib.parse import quote
    path = quote(environ.get("PATH_INFO", "/").encode("latin-1"), safe="/%:@!$&'()*+,;=")
    query = environ.get("QUERY_STRING", "")
    return path + ("?" + query if query else "")


def app(environ, start_response):
    """WSGI entry point: forwards the request to the Node app and relays the reply."""
    if _node is None or _node.poll() is not None:
        # Not started by the gunicorn hook (some other WSGI server): start it now.
        threading.Thread(target=supervise, args=(INNER_PORT,), daemon=True).start()

    if not wait_for_port(INNER_PORT, timeout=90):
        start_response(
            "503 Service Unavailable",
            [("Content-Type", "text/plain; charset=utf-8"), ("Retry-After", "5")],
        )
        return [b"The shop is starting up. Please refresh in a few seconds."]

    # Only read a body when the request says it has one. Reading to end-of-stream
    # on a GET would block forever on a keep-alive connection.
    length = environ.get("CONTENT_LENGTH") or ""
    if length.isdigit() and int(length) > 0:
        body = environ["wsgi.input"].read(int(length))
    elif environ.get("HTTP_TRANSFER_ENCODING", "").lower() == "chunked":
        body = environ["wsgi.input"].read()  # gunicorn de-chunks and ends the stream
    else:
        body = b""
    headers = _request_headers(environ)
    headers["Content-Length"] = str(len(body))

    conn = http.client.HTTPConnection("127.0.0.1", INNER_PORT, timeout=120)
    try:
        conn.request(environ["REQUEST_METHOD"], _request_target(environ), body=body, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
    except (OSError, http.client.HTTPException) as err:
        conn.close()
        start_response("502 Bad Gateway", [("Content-Type", "text/plain; charset=utf-8")])
        return [f"The shop did not answer ({err}). Please refresh.".encode()]

    out = [
        (name, value)
        for name, value in resp.getheaders()  # keeps repeated Set-Cookie headers
        if name.lower() not in _HOP_BY_HOP and name.lower() != "content-length"
    ]
    out.append(("Content-Length", str(len(data))))
    start_response(f"{resp.status} {resp.reason}", out)
    conn.close()
    return [data]


application = app  # gunicorn app:application also works


if __name__ == "__main__":
    # `python app.py`: no proxy needed, just become the Node process on $PORT.
    ensure_dependencies()
    os.chdir(ROOT)
    os.execvp("node", ["node", NODE_ENTRY] + sys.argv[1:])
