"""WSGI entrypoint for hosts that run `gunicorn app:app`.

Do NOT monkey-patch here; monkey-patching the master/arbiter process
can cause blocking calls inside Gunicorn's mainloop. Workers using the
`eventlet` worker class will be greened by the worker process.

This module simply re-exports the Flask `app` for Gunicorn to import.
"""

from main import app  # re-export the Flask app for gunicorn

