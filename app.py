"""WSGI entrypoint shim.

Render or other hosts sometimes expect `app:app`. This file
exposes the `app` created in `main.py` so both `gunicorn app:app`
and `gunicorn main:app` work.
"""
from main import app  # re-export the Flask app
