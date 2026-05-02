from flask_socketio import SocketIO
from flask_mail import Mail
try:
	from cachelib import SimpleCache
except Exception:
	# Lightweight fallback if cachelib is not available during local runs.
	import time

	class SimpleCache:
		def __init__(self):
			self._d = {}

		def set(self, key, value, timeout=300):
			expire = time.time() + (timeout or 0)
			self._d[key] = (value, expire)

		def get(self, key):
			v = self._d.get(key)
			if not v:
				return None
			value, expire = v
			if expire and time.time() > expire:
				try:
					del self._d[key]
				except KeyError:
					pass
				return None
			return value
from functools import wraps
from flask import request

from .database_utils import db

mail = Mail()


class SimpleFlaskCache:
	"""Minimal cache wrapper providing `init_app` and `cached` decorator.

	This avoids adding `Flask-Caching` which has conflicting constraints
	with Flask 3.x. Uses `cachelib.SimpleCache` as the backend.
	"""

	def __init__(self):
		self._cache = None

	def init_app(self, app=None):
		# initialize the underlying SimpleCache instance
		self._cache = SimpleCache()

	def get(self, key):
		return self._cache.get(key) if self._cache else None

	def set(self, key, value, timeout=300):
		if self._cache:
			self._cache.set(key, value, timeout=timeout)

	def make_cache_key(self, namespace=None, query_string=False):
		# Build a simple key based on path and optionally query string
		key = request.path
		if query_string and request.query_string:
			key = key + "?" + request.query_string.decode('utf-8')
		return key

	def cached(self, timeout=60, query_string=False):
		def decorator(f):
			@wraps(f)
			def wrapped(*args, **kwargs):
				if not self._cache:
					return f(*args, **kwargs)
				key = self.make_cache_key(query_string=query_string)
				rv = self.get(key)
				if rv is not None:
					return rv
				rv = f(*args, **kwargs)
				# Only cache successful JSON responses (tuple or Response)
				try:
					self.set(key, rv, timeout=timeout)
				except Exception:
					pass
				return rv
			return wrapped
		return decorator


cache = SimpleFlaskCache()
# Explicitly set async_mode to 'eventlet' so server and client use the same async driver.
# cors_allowed_origins set here to ensure Socket.IO accepts connections from the frontend.
socketio = SocketIO(async_mode='eventlet', cors_allowed_origins="*", manage_session=True)
