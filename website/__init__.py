from flask import Flask
from flask_cors import CORS
import os
import pymysql

from website.database_utils import db
from website.extension import socketio

# Import Blueprints
from website.auth import auth
from website.view import view
from website.BusRoute import bus
from website.get_data import get_data
from website.chatbot import bot
from website.chat import chat

pymysql.install_as_MySQLdb()

def create_app():
    app = Flask(__name__)

    # ===========================
    # ✅ Read configs from env (Railway manages this)
    # ===========================
    app.config["SECRET_KEY"] = os.getenv("SECRET_KEY")

    # ✅ Use Railway MySQL URL (injected from DB service)
    app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv("DATABASE_URL")

    app.config["DEBUG"] = False
    app.config["PORT"] = 5000
    app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16MB

    # ===========================
    # ✅ Upload folder (lightweight)
    # ===========================
    upload_folder = os.path.join(os.getcwd(), os.getenv("UPLOAD_FOLDER", "uploads"))
    os.makedirs(upload_folder, exist_ok=True)
    app.config["UPLOAD_FOLDER"] = upload_folder

    # ===========================
    # ✅ Init extensions
    # ===========================
    db.init_app(app)
    socketio.init_app(app, cors_allowed_origins="*")
    CORS(app, supports_credentials=True)

    # ===========================
    # ✅ Register blueprints
    # ===========================
    app.register_blueprint(auth, url_prefix="/auth")
    app.register_blueprint(view, url_prefix="/view")
    app.register_blueprint(bus, url_prefix="/bus")
    app.register_blueprint(get_data, url_prefix="/data")

    # ⚠ AI/GPU part is skipped safely because `chatbot.py` now handles missing libs
    app.register_blueprint(bot, url_prefix="/chatbot")
    app.register_blueprint(chat, url_prefix="/chat")

    # ===========================
    # ✅ Create DB tables only when DATABASE_URL exists
    # ===========================
    with app.app_context():
        uri = os.getenv("DATABASE_URL")
        if uri:   # Railway injects this, local deploy may not → so this protects container boot
            try:
                db.create_all()
                print("DataBase Tables Created ✅ (via Railway-managed MySQL)")
            except Exception as e:
                print("⚠ DB Init Warning (table creation skipped):", e)
        else:
            print("⚠ DATABASE_URL not found locally — DB part skipped during deploy test")

    return app
