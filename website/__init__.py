from flask import Flask
from flask_cors import CORS
import os
import pymysql
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

    # Determine DB URL: prefer LOCAL_DATABASE_URL (Aiven MySQL), then DATABASE_URL, then fallback.
    db_url = os.getenv("LOCAL_DATABASE_URL") or os.getenv("DATABASE_URL")
    if not db_url:
        # Fallback to local DB for development
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
    # Configure SQLAlchemy engine options for remote MySQL (Aiven) with SSL
    # This will be passed to the underlying SQLAlchemy engine via Flask-SQLAlchemy.
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
        "connect_args": {"ssl": {"ssl": {}}}
    }

    db.init_app(app)

    # Build CORS configuration. If FRONTEND_URL is provided, use it exactly.
    # Otherwise, allow Vercel preview/deployment domains using a regex and
    # permit localhost during local development when ALLOW_LOCAL is enabled.
    frontend_origin = os.getenv("FRONTEND_URL")
    allow_local = os.getenv("ALLOW_LOCAL", "true").lower() in ("1", "true", "yes")

    if frontend_origin:
        socketio_origins = [frontend_origin]
        cors_origins = [frontend_origin]
        if allow_local:
            cors_origins.extend(["http://localhost:3000", "http://127.0.0.1:3000"])

        # dedupe
        cors_origins = list(dict.fromkeys(cors_origins))

        socketio.init_app(app, cors_allowed_origins=socketio_origins)
        CORS(app, supports_credentials=True, origins=cors_origins)
    else:
        # No explicit FRONTEND_URL set — accept Vercel preview domains via regex for HTTP
        vercel_regex = r"^https://([a-z0-9-]+\.)?vercel\.app$"
        resources = {r"/*": {"origins": vercel_regex}}
        if allow_local:
            # allow local dev as well
            resources[r"/*"]["origins"] = [vercel_regex, "http://localhost:3000", "http://127.0.0.1:3000"]

        # For Socket.IO, allow all origins when FRONTEND_URL is not specified (Socket.IO
        # does not accept the same regex resource format). This is intentionally
        # permissive so live Vercel deployments can connect; set FRONTEND_URL in Render
        # for stricter control.
        socketio.init_app(app, cors_allowed_origins="*")
        CORS(app, supports_credentials=True, resources=resources)

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
