from dotenv import load_dotenv
import os

load_dotenv()

class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "--default-secret--")

    # 1️⃣ Try local DATABASE_URL from .env
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL")

    # 2️⃣ If not found, try Railway MySQL URLs
    if not SQLALCHEMY_DATABASE_URI:
        SQLALCHEMY_DATABASE_URI = (
            os.getenv("MYSQL_URL") or
            os.getenv("MYSQL_PUBLIC_URL")
        )

    # 3️⃣ If still missing → print warning
    if not SQLALCHEMY_DATABASE_URI:
        print("❌ ERROR: No valid SQLALCHEMY_DATABASE_URI found!")

    SQLALCHEMY_TRACK_MODIFICATIONS = False
    UPLOAD_FOLDER = os.path.join(os.getcwd(), "uploads")
