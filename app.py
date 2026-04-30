"""WSGI entrypoint for hosts that run `gunicorn app:app`.

Ensure eventlet is monkey-patched before importing the application
so eventlet green-threads are installed before any modules create
threading primitives (prevents "RLock(s) were not greened" warning).
"""
import eventlet
eventlet.monkey_patch()

from main import app  # re-export the Flask app for gunicorn

