"""WSGI entrypoint shim.

Ensure `eventlet.monkey_patch()` runs before other imports so eventlet's
green threads are properly initialized when Gunicorn loads this module.

Render or other hosts sometimes expect `app:app`. This file
exposes the `app` created in `main.py` so both `gunicorn app:app`
and `gunicorn main:app` work.
"""
import eventlet
eventlet.monkey_patch()

from main import app  # re-export the Flask app
