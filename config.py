from dotenv import load_dotenv
import os

load_dotenv()

class Config:
    # Security
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-key")
    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY")
    JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")

    # Database: fully managed by Railway
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL")  # must be set as ${{ MySQL.MYSQL_URL }} in Railway
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Flask runtime
    DEBUG = os.getenv("DEBUG", "False") == "True"
    PORT = int(os.getenv("PORT", 5000))

    # Uploads & limits
    UPLOAD_FOLDER = os.path.join(os.getcwd(), os.getenv("UPLOAD_FOLDER", "uploads"))
    MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_LENGTH", 16777216))

    # Cookie / session security for production
    SESSION_COOKIE_SECURE = True
    SESSION_COOKIE_SAMESITE = None
    SESSION_COOKIE_HTTPONLY = True
