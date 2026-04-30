from flask import Flask
from flask_cors import CORS
import os
import pymysql
import re
from dotenv import load_dotenv

load_dotenv()

from website.database_utils import db
from website.extension import socketio  # Socket.IO initialized here

# Import Blueprints
from website.auth import auth
from website.view import view
from website.BusRoute import bus
from website.get_data import get_data
from website.chat import chat

# Use pymysql as MySQLdb
pymysql.install_as_MySQLdb()

DB_NAME = "hackathon"


def create_app():
    app = Flask(__name__)

    # ===========================
    # APP CONFIG
    # ===========================
    app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", '--Hackathon@inovatrix@-@2580#1234--')

    # Determine DB URL: prefer LOCAL_DATABASE_URL (Aiven MySQL), then DATABASE_URL.
    db_url = os.getenv("LOCAL_DATABASE_URL") or os.getenv("DATABASE_URL")

    # If no DB URL in environment, fail fast in production so deploy doesn't silently run without DB.
    if not db_url:
        is_prod = os.getenv("FLASK_ENV", "").lower() == "production" or os.getenv("RENDER") is not None
        if is_prod:
            raise RuntimeError(
                "No database URL found. Set LOCAL_DATABASE_URL or DATABASE_URL in environment before deploying."
            )
        # development fallback (safe default for local testing)
        print("⚠ No DB URL found in env — falling back to local development DB.")
        db_url = f"mysql+pymysql://root:password@127.0.0.1:3306/{DB_NAME}"

    # Normalize mysql scheme to use PyMySQL dialect
    if db_url.startswith("mysql://"):
        db_url = db_url.replace("mysql://", "mysql+pymysql://", 1)

    # Remove any ssl-related query params (e.g. ssl-mode, ssl_mode, sslmode)
    if "?" in db_url:
        base, q = db_url.split("?", 1)
        parts = []
        for pair in q.split("&"):
            k = pair.split("=", 1)[0].lower()
            if k.startswith("ssl") or k.startswith("ssl-") or k == "sslmode":
                # drop ssl-related param
                continue
            parts.append(pair)
        db_url = base + ("?" + "&".join(parts) if parts else "")

    # Mask credentials when logging
    try:
        masked = re.sub(r"//.*@", "//***@", db_url)
    except Exception:
        masked = db_url
    print("Using SQLALCHEMY_DATABASE_URI:", masked)

    app.config["SQLALCHEMY_DATABASE_URI"] = db_url
    app.config["SESSION_COOKIE_SAMESITE"] = os.getenv("SESSION_COOKIE_SAMESITE", "Lax")
    app.config["SESSION_COOKIE_SECURE"] = _ = (os.getenv("SESSION_COOKIE_SECURE", "False").lower() in ("1","true","yes"))
    app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_CONTENT_LENGTH", 16 * 1024 * 1024))

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
    app.register_blueprint(chat, url_prefix="/chat")

    # ===========================
    # Create Database Tables
    # ===========================
    with app.app_context():
        try:
            db.create_all()
            app.config['DB_CONNECTED'] = True
            print("DataBase Tables Created ✅")
        except Exception as e:
            app.config['DB_CONNECTED'] = False
            print("❌ Could not initialize database (continuing without DB):", e)

    return app
