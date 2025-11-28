from flask import Flask
from flask_cors import CORS
import os
import pymysql
from dotenv import load_dotenv

from website.database_utils import db
from website.extension import socketio

from config import Config  # ✅ production config loader

# Import Blueprints
from website.auth import auth
from website.view import view
from website.BusRoute import bus
from website.get_data import get_data
from website.chatbot import bot
from website.chat import chat

# Use pymysql as MySQLdb
pymysql.install_as_MySQLdb()

load_dotenv()  # ✅ load .env file

def create_app():
    app = Flask(__name__)

    # ===================
    # LOAD CONFIG FROM ENV
    # ===================
    app.config.from_object(Config)

    # ===================
    # INITIALIZE EXTENSIONS
    # ===================
    db.init_app(app)
    socketio.init_app(app, cors_allowed_origins="*")  # Socket allows all origins ✅
    CORS(app, supports_credentials=True)

    # ===================
    # SET UP UPLOAD FOLDER
    # ===================
    upload_folder = os.path.join(os.getcwd(), app.config["UPLOAD_FOLDER"])
    os.makedirs(upload_folder, exist_ok=True)
    app.config["UPLOAD_FOLDER"] = upload_folder

    # ===================
    # REGISTER BLUEPRINTS
    # ===================
    app.register_blueprint(auth, url_prefix="/auth")
    app.register_blueprint(view, url_prefix="/view")
    app.register_blueprint(bus, url_prefix="/bus")
    app.register_blueprint(get_data, url_prefix="/data")
    app.register_blueprint(bot, url_prefix="/chatbot")
    app.register_blueprint(chat, url_prefix="/chat")

    # ===================
    # CREATE DB TABLES
    # ===================
    with app.app_context():
        db.create_all()
        print("Database Tables Created ✅")

    return app

app = create_app()  # ✅ create flask app instance
if __name__ == "__main__":
    socketio.run(app, debug=app.config["DEBUG"], port=app.config["PORT"])
