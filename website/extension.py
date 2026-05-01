from flask_socketio import SocketIO
from flask_mail import Mail
from flask_caching import Cache
from .database_utils import db

mail = Mail()
cache = Cache()
socketio = SocketIO(cors_allowed_origins="*", manage_session=True)
