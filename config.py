from dotenv import load_dotenv
import os

load_dotenv()

class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-key")

    DB_HOST = os.getenv("MYSQLHOST")
    DB_USER = os.getenv("MYSQLUSER")
    DB_PASSWORD = os.getenv("MYSQLPASSWORD")
    DB_NAME = os.getenv("MYSQLDATABASE")

    # ✅ FIX: ensure port is read safely
    DB_PORT = os.getenv("MYSQLPORT")
    if DB_PORT and DB_PORT.isdigit():
        DB_PORT = int(DB_PORT)
    else:
        DB_PORT = 3306   # fallback
        print("⚠ Using fallback MySQL port 3306")

    # ✅ Railway-managed URL takes priority
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL")
    if not SQLALCHEMY_DATABASE_URI and DB_HOST:
        SQLALCHEMY_DATABASE_URI = f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

    SQLALCHEMY_TRACK_MODIFICATIONS = False
