from flask import Flask, jsonify
from flask_cors import CORS
from config import Config
from website.database_utils import db
from website.extension import socketio
import pymysql
import os

pymysql.install_as_MySQLdb()

def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    # ========== DATABASE SETUP ==========
    try:
        if not app.config.get("SQLALCHEMY_DATABASE_URI"):
            print("❌ MySQL connection string (MYSQL_URI) not found!")
        else:
            db.init_app(app)
            with app.app_context():
                db.create_all()
            print("✅ Connected to MySQL & tables created!")
    except Exception as e:
        print("❌ MySQL connection failed:", e)

    # ========== SOCKET.IO ==========
    socketio.init_app(app, cors_allowed_origins="*")

    # ========== CORS ENABLE ==========
    CORS(app, supports_credentials=True)

    # ========== ERROR HANDLERS ==========
    @app.errorhandler(404)
    def not_found(e):
        return jsonify({"error": "Resource not found"}), 404

    @app.errorhandler(500)
    def server_error(e):
        return jsonify({"error": "Internal Server Error"}), 500

    # ========== BLUEPRINTS ==========
    from website.auth import auth
    from website.view import view
    from website.BusRoute import bus
    from website.get_data import get_data
    from website.chat import chat
    from website.chatbot import bot

    app.register_blueprint(auth, url_prefix="/auth")
    app.register_blueprint(view, url_prefix="/view")
    app.register_blueprint(bus, url_prefix="/bus")
    app.register_blueprint(get_data, url_prefix="/data")
    app.register_blueprint(chat, url_prefix="/chat")
    app.register_blueprint(bot, url_prefix="/chatbot")

    return app
