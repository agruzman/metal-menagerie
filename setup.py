"""
setup.py — runs `npm install` while pip is building this folder.

pip executes this file when it sees the "." line in requirements.txt, which
only happens on a hosting service configured with the Python runtime. That is
our chance to install the Node.js dependencies during the build step, where
there is plenty of CPU, instead of at start-up on a tiny free instance.
"""
import os
import shutil
import subprocess

from setuptools import setup

ROOT = os.path.dirname(os.path.abspath(__file__))

if not os.path.isdir(os.path.join(ROOT, "node_modules", "express")):
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit(
            "[shim] npm was not found on this machine, so the Node.js dependencies "
            "cannot be installed. Add a .node-version file (this repo has one) or "
            "switch the service's runtime to Node."
        )
    print("[shim] Installing Node.js dependencies: npm install --omit=dev", flush=True)
    subprocess.check_call(
        [npm, "install", "--omit=dev", "--no-audit", "--no-fund"], cwd=ROOT
    )

setup()
