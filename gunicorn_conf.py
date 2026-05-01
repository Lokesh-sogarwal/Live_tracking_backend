# Gunicorn configuration for moderate-memory environments
# Use with: gunicorn -c gunicorn_conf.py app:app

worker_class = "eventlet"
workers = 1
threads = 1
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
