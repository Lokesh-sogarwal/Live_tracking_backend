from dotenv import load_dotenv
import os

load_dotenv()

class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "--default-secret--")

    # 1️⃣ Priority: Railway MySQL URL (Private)
    SQLALCHEMY_DATABASE_URI = os.getenv("MYSQL_URL")

    # 2️⃣ Priority: Railway Public URL (if local testing with remote DB)
    if not SQLALCHEMY_DATABASE_URI:
        SQLALCHEMY_DATABASE_URI = os.getenv("MYSQL_PUBLIC_URL")

    # 3️⃣ Priority: Generic DATABASE_URL (Local .env)
    if not SQLALCHEMY_DATABASE_URI:
        SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL")

    # 🔧 Fix Protocol for PyMySQL
    if SQLALCHEMY_DATABASE_URI and SQLALCHEMY_DATABASE_URI.startswith("mysql://"):
        SQLALCHEMY_DATABASE_URI = SQLALCHEMY_DATABASE_URI.replace("mysql://", "mysql+pymysql://")

    # 3️⃣ If still missing → print warning
    if not SQLALCHEMY_DATABASE_URI:
        print("❌ ERROR: No valid SQLALCHEMY_DATABASE_URI found!")

    SQLALCHEMY_TRACK_MODIFICATIONS = False
    UPLOAD_FOLDER = os.path.join(os.getcwd(), "uploads")
