from flask import Flask
from website.auth import auth
from website.view import view
from website.BusRoute import bus
from website.get_data import get_data
from flask_cors import CORS
from website.database_utils import db
import os

DB_NAME = "hackathon"

def create_app():
    APP_SECRET_KEY = '--Hackathon@inovatrix@-@2580#1234--'
    app = Flask(__name__)
    app.config['SQLALCHEMY_DATABASE_URI'] = f'mysql://root@localhost/{DB_NAME}'
    app.config['SECRET_KEY'] = APP_SECRET_KEY
    app.config['SESSION_COOKIE_SAMESITE'] = "Lax"
    app.config['SESSION_COOKIE_SECURE'] = False

    app.config['UPLOAD_FOLDER'] = os.path.join(os.getcwd(), "uploads")
    app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16 MB

    if not os.path.exists(app.config['UPLOAD_FOLDER']):
        os.makedirs(app.config['UPLOAD_FOLDER'])

    # Initialize DB
    db.init_app(app)
    CORS(app, supports_credentials=True)

    # Register blueprints
    app.register_blueprint(auth, url_prefix='/auth')
    app.register_blueprint(view, url_prefix='/view')
    app.register_blueprint(bus, url_prefix='/bus')
    app.register_blueprint(get_data, url_prefix='/data')

    # Create tables
    create_tables(app)

    return app


def create_tables(app):
    with app.app_context():
        db.create_all()
        print("DataBase Tables Created ✅")
