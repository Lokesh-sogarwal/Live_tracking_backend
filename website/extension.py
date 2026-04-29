from flask_socketio import SocketIO
from flask_mail import Mail
from .database_utils import db

mail = Mail()
socketio = SocketIO(cors_allowed_origins="*", manage_session=True)
