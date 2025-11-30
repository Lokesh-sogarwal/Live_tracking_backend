from dotenv import load_dotenv
import os

load_dotenv()

class Config:
    # ===== SECURITY =====
    SECRET_KEY = os.getenv("SECRET_KEY")
    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY")
    JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")

    # ===== Database Managed by Railway =====
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL")  # ✅ correct
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # ===== Flask Runtime =====
    DEBUG = False
    PORT = 5000

    # ===== Uploads & Limits =====
    UPLOAD_FOLDER = os.path.join(os.getcwd(), os.getenv("UPLOAD_FOLDER", "uploads"))
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024

    # ===== Cookies for Production =====
    SESSION_COOKIE_SECURE = True
    SESSION_COOKIE_SAMESITE = None
    SESSION_COOKIE_HTTPONLY = True
