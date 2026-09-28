"""
gunicorn.conf.py — picked up automatically by `gunicorn app:app`.

Only used when the hosting service runs the Python runtime; see app.py.
Starts the Node app once (in the gunicorn master) and keeps it alive.
"""
import os
import threading

bind = f"0.0.0.0:{os.environ.get('PORT', '10000')}"
workers = 1
worker_class = "gthread"
threads = 8
timeout = 180
graceful_timeout = 30
keepalive = 5
accesslog = None


def on_starting(server):
    import app

    threading.Thread(target=app.supervise, args=(app.INNER_PORT,), daemon=True).start()
