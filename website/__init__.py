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
                # Ensure all models are imported before table creation.
                # Without this, new models (e.g., RolePermission) may not be created.
                import website.model  # noqa: F401
                db.create_all()

                # Seed common roles if the roles table is empty.
                from website.model import Role

                if Role.query.count() == 0:
                    for name in ["Superadmin", "Admin", "operator", "driver", "passenger"]:
                        db.session.add(Role(role_name=name))
                    db.session.commit()
            print("✅ Connected to MySQL & tables created!")
    except Exception as e:
        print("❌ MySQL connection failed:", e)

    # ========== SOCKET.IO ==========
    socketio.init_app(app, cors_allowed_origins="*")

    # ========== CORS ENABLE ==========
    # Frontend runs on http://localhost:3000 (CRA). Requests include Authorization header,
    # which triggers a browser preflight (OPTIONS). Ensure it succeeds.
    CORS(
        app,
        supports_credentials=True,
        resources={
            r"/*": {
                "origins": [
                    "http://localhost:3000",
                    "http://127.0.0.1:3000",
                ]
            }
        },
        allow_headers=["Content-Type", "Authorization"],
        methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    )

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
    from website.permissions import permissions
    try:
        from website.billing import billing  # type: ignore
    except Exception as e:
        billing = None
        print("⚠ Billing module not available, skipping:", e)

    app.register_blueprint(auth, url_prefix="/auth")
    app.register_blueprint(view, url_prefix="/view")
    app.register_blueprint(bus, url_prefix="/bus")
    app.register_blueprint(get_data, url_prefix="/data")
    app.register_blueprint(chat, url_prefix="/chat")
    app.register_blueprint(bot, url_prefix="/chatbot")
    app.register_blueprint(permissions, url_prefix="/permissions")
    if billing is not None:
        app.register_blueprint(billing, url_prefix="/billing")

    # Seed billing catalog (plans/addons) if needed
    if billing is not None:
        try:
            with app.app_context():
                from website.billing import seed_billing_catalog

                seed_billing_catalog()
        except Exception as e:
            print("⚠ Billing seed skipped:", e)

    return app
