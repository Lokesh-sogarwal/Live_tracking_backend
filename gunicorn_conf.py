# Gunicorn configuration for moderate-memory environments
# Use with: gunicorn -c gunicorn_conf.py app:app

import os

worker_class = "eventlet"
# Allow overriding worker count via env; default 1 to limit memory. Increase when Redis is present.
workers = int(os.getenv("GUNICORN_WORKERS", "1"))
threads = int(os.getenv("GUNICORN_THREADS", "1"))
timeout = 120
keepalive = 2
# Recycle workers after a number of requests to avoid memory leaks
max_requests = 1000
max_requests_jitter = 100
preload_app = False

# Logging
loglevel = "info"
accesslog = "-"
errorlog = "-"
