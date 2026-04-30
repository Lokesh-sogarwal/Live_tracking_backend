from dotenv import load_dotenv
import os
from urllib.parse import urlparse

# Load env vars from backend .env without overriding real environment variables.
_BACKEND_ENV_PATH = os.path.join(os.path.dirname(__file__), ".env")
load_dotenv(_BACKEND_ENV_PATH, override=False)

# Also allow a root-level .env (optional), again without override.
load_dotenv(override=False)


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def _is_localhost_url(url: str | None) -> bool:
    if not url:
        return False
    try:
        host = (urlparse(url).hostname or "").strip().lower()
        return host in {"localhost", "127.0.0.1", "::1"}
    except Exception:
        return False


def _scheme(url: str | None) -> str:
    if not url:
        return ""
    try:
        return (urlparse(url).scheme or "").lower()
    except Exception:
        return ""


def _is_postgres_url(url: str | None) -> bool:
    s = _scheme(url)
    return s in {"postgres", "postgresql", "postgresql+psycopg2"}


def _is_mysql_url(url: str | None) -> bool:
    s = _scheme(url)
    return s in {"mysql", "mysql+pymysql"}


def _normalize_db_url(url: str | None) -> str | None:
    if not url:
        return None

    url = url.strip()

    # MySQL
    if url.startswith("mysql://"):
        url = url.replace("mysql://", "mysql+pymysql://", 1)

    # Postgres
    # Many providers still use postgres://; SQLAlchemy expects postgresql://
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg2://", 1)
    elif url.startswith("postgresql://") and "postgresql+" not in url:
        url = url.replace("postgresql://", "postgresql+psycopg2://", 1)

    return url

class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "--default-secret--")

    # ===== Billing / Payment Gateway =====
    # Supported: "dummy" (default), "razorpay"
    BILLING_GATEWAY = os.getenv("BILLING_GATEWAY", "dummy").strip().lower()

    # Razorpay (test/live keys). Keep these in Railway env vars.
    RAZORPAY_KEY_ID = os.getenv("RAZORPAY_KEY_ID")
    RAZORPAY_KEY_SECRET = os.getenv("RAZORPAY_KEY_SECRET")

    # =============================
    # Database auto-selection
    # =============================
    # Goal: local dev (localhost) -> MySQL, deployed/non-local -> Postgres.
    # You can override behavior via env vars:
    # - USE_LOCAL_MYSQL=1 forces MySQL
    # - USE_POSTGRES=1 forces Postgres
    # Provide URLs via:
    # - LOCAL_DATABASE_URL (recommended for local MySQL)
    # - POSTGRES_URL / POSTGRES_PUBLIC_URL (recommended for Postgres)
    # - MYSQL_URL / MYSQL_PUBLIC_URL (existing)
    # - DATABASE_URL (generic fallback)

    _force_mysql = _truthy(os.getenv("USE_LOCAL_MYSQL"))
    _force_pg = _truthy(os.getenv("USE_POSTGRES"))

    _generic = os.getenv("DATABASE_URL")
    _local_mysql = os.getenv("LOCAL_DATABASE_URL") or os.getenv("MYSQL_LOCAL_URL")
    _mysql_private = os.getenv("MYSQL_URL")
    _mysql_public = os.getenv("MYSQL_PUBLIC_URL")
    _pg_private = os.getenv("POSTGRES_URL") or os.getenv("PG_URL")
    _pg_public = os.getenv("POSTGRES_PUBLIC_URL") or os.getenv("PG_PUBLIC_URL")

    # Only use MySQL when running against localhost.
    # (Render + Supabase should always be Postgres, regardless of DEBUG flag.)
    _is_local = _force_mysql or _is_localhost_url(_generic) or _is_localhost_url(_local_mysql)

    SQLALCHEMY_DATABASE_URI = None

    if _is_local and not _force_pg:
        # Local: require localhost MySQL URL.
        SQLALCHEMY_DATABASE_URI = _local_mysql or _generic
    else:
        # Non-local/deployed (Render): prefer Postgres (Supabase).
        SQLALCHEMY_DATABASE_URI = _pg_private or _pg_public or _generic

    # As a last resort, fall back to any MySQL URLs (keeps backward compatibility).
    if not SQLALCHEMY_DATABASE_URI:
        SQLALCHEMY_DATABASE_URI = _mysql_private or _mysql_public

    # If generic DATABASE_URL is MySQL but not localhost, ignore it unless forced.
    if (
        SQLALCHEMY_DATABASE_URI == _generic
        and _is_mysql_url(_generic)
        and not _is_localhost_url(_generic)
        and not _force_mysql
        and (_pg_private or _pg_public)
    ):
        SQLALCHEMY_DATABASE_URI = _pg_private or _pg_public

    SQLALCHEMY_DATABASE_URI = _normalize_db_url(SQLALCHEMY_DATABASE_URI)

    if not SQLALCHEMY_DATABASE_URI:
        print("❌ ERROR: No valid SQLALCHEMY_DATABASE_URI found! Set LOCAL_DATABASE_URL or POSTGRES_URL.")

<<<<<<< HEAD
=======
    # Database: prefer `LOCAL_DATABASE_URL` (Aiven MySQL) to ensure the app
    # always uses the Aiven MySQL instance in this deployment.
    SQLALCHEMY_DATABASE_URI = os.getenv("LOCAL_DATABASE_URL") or os.getenv("DATABASE_URL")
>>>>>>> dc5dc98 (Make it render ready)
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    UPLOAD_FOLDER = os.path.join(os.getcwd(), "uploads")
