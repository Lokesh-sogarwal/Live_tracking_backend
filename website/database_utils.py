try:
    from flask_sqlalchemy import SQLAlchemy
    from flask_mail import Mail
    mail = Mail()
    db = SQLAlchemy()
except ModuleNotFoundError as e:
    print("⚠ Extension import skipped:", e)
    mail = None
    db = None
