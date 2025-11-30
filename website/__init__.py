from flask import Flask
from flask_cors import CORS
import os
import pymysql

from website.database_utils import db
from website.extension import socketio  # Socket.IO initialized here

# Import Blueprints
from website.auth import auth
from website.view import view
from website.BusRoute import bus
from website.get_data import get_data
from website.chatbot import bot
from website.chat import chat

# Use pymysql as MySQLdb
pymysql.install_as_MySQLdb()

DB_NAME = "hackathon"


def create_app():
    app = Flask(__name__)

    # ===========================
    # APP CONFIG
    # ===========================
    app.config["SECRET_KEY"] = '--Hackathon@inovatrix@-@2580#1234--'
    app.config["SQLALCHEMY_DATABASE_URI"] = f"mysql+pymysql://root:Lok%402004@localhost/{DB_NAME}"
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_SECURE"] = False
    app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16 MB

    # Upload directory
    upload_folder = os.path.join(os.getcwd(), "uploads")
    os.makedirs(upload_folder, exist_ok=True)
    app.config["UPLOAD_FOLDER"] = upload_folder

    # ===========================
    # Initialize Extensions
    # ===========================
    db.init_app(app)
    socketio.init_app(app, cors_allowed_origins="*")   # ★ IMPORTANT FIX ★
    CORS(app, supports_credentials=True)

    # ===========================
    # Register Blueprints
    # ===========================
    app.register_blueprint(auth, url_prefix="/auth")
    app.register_blueprint(view, url_prefix="/view")
    app.register_blueprint(bus, url_prefix="/bus")
    app.register_blueprint(get_data, url_prefix="/data")
    app.register_blueprint(bot, url_prefix="/chatbot")
    app.register_blueprint(chat, url_prefix="/chat")

    # ===========================
    # Create Database Tables
    # ===========================
    with app.app_context():
        db.create_all()
        print("DataBase Tables Created ✅")

    return app
