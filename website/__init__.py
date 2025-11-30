from flask import Flask
from flask_cors import CORS
import os
import pymysql

from website.database_utils import db
from website.extension import socketio
from config import Config # Make sure this path is correct

pymysql.install_as_MySQLdb()

def create_app():
    app = Flask(__name__)

    # ===== CONFIG LOAD (Railway managed) =====
    app.config.from_object(Config)

    # ===== OPTIONAL: USE DATABASE URL DIRECTLY IF YOU WANT IT IN CODE =====
    # Uncomment this only if you want to hardcode Railway URL (not recommended for security)
    #
    # app.config["SQLALCHEMY_DATABASE_URI"] = "mysql+pymysql://your-railway-url-here"

    # ===== Initialize extensions with protection =====
    try:
        db.init_app(app)
        uri = os.getenv("DATABASE_URL")
        if not uri:
            print("⚠ DATABASE_URL missing — DB init skipped for test deploy")
        else:
            app.config["SQLALCHEMY_DATABASE_URI"] = uri
            with app.app_context():
                db.create_all()
                print("✅ DB connected & tables created (Railway Managed)")
    except Exception as e:
        print("⚠ DB extension failed but container will continue:", e)

    socketio.init_app(app, cors_allowed_origins="*")

    # ==== CORS ====
    CORS(app, supports_credentials=True)

    # ===== Blueprint registration, skip bot AI if missing =====
    from website.auth import auth
    from website.view import view
    from website.BusRoute import bus
    from website.get_data import get_data
    from website.chat import chat

    app.register_blueprint(auth, url_prefix="/auth")
    app.register_blueprint(view, url_prefix="/view")
    app.register_blueprint(bus, url_prefix="/bus")
    app.register_blueprint(get_data, url_prefix="/data")
    app.register_blueprint(chat, url_prefix="/chat")

    # ===== Skip Chatbot AI while deploying =====
    if False:  # Always False during deployment → bot AI will be skipped
        try:
            from website.chatbot import bot
            app.register_blueprint(bot, url_prefix="/chatbot")
        except:
            print("⚠ chatbot AI skipped (torch/transformers not installed)")

    return app
