import uuid
from website.database_utils import db

# -----------------------
# User Model
# -----------------------
class User(db.Model):
    __tablename__='users'
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.String(36), unique=True, default=lambda: str(uuid.uuid4()))
    fullname = db.Column(db.String(150), nullable=False)
    email = db.Column(db.String(150), unique=True, nullable=False)
    password = db.Column(db.String(200), nullable=False)
    phone_no = db.Column(db.String(20), nullable=True)
    is_password_change = db.Column(db.Boolean, default=False, nullable=False)
    date_created = db.Column(db.DateTime, nullable=False, default=db.func.current_timestamp())
    date_updated = db.Column(db.DateTime, nullable=False, default=db.func.current_timestamp(), onupdate=db.func.current_timestamp())

    def __repr__(self):
        return f'<User {self.fullname}>'

# -----------------------
# Active Users
# -----------------------
class Active_user(db.Model):
    id = db.Column(db.String(36), primary_key=True, unique=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete="CASCADE"), nullable=False)
    fullname = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(100), nullable=False)
    role = db.Column(db.String(100), nullable=False)
    login_time = db.Column(db.DateTime, nullable=False, default=db.func.current_timestamp())
    logout_time = db.Column(db.DateTime, nullable=True)

    user = db.relationship("User", backref="active_sessions")


# -----------------------
# Transport Entities
# -----------------------
class Bus(db.Model):
    __tablename__ = 'buses'
    bus_id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    bus_number = db.Column(db.String(50), unique=True, nullable=False)
    capacity = db.Column(db.Integer, nullable=True)
    operator = db.Column(db.String(150), nullable=True)

    def __repr__(self):
        return f"<Bus {self.bus_number}>"


class Route(db.Model):
    __tablename__ = "routes"

    route_id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    route_name = db.Column(db.String(100), nullable=False)

    # Start point
    start_point = db.Column(db.String(150), nullable=False)  # city/place name
    start_lat = db.Column(db.Float, nullable=False)
    start_lng = db.Column(db.Float, nullable=False)

    # End point
    end_point = db.Column(db.String(150), nullable=False)  # city/place name
    end_lat = db.Column(db.Float, nullable=False)
    end_lng = db.Column(db.Float, nullable=False)

    # Optional: relationships
    schedules = db.relationship("Schedule", backref="route", lazy=True)

    def __repr__(self):
        return f"<Route {self.route_name}: {self.start_point} → {self.end_point}>"

class Stop(db.Model):
    __tablename__ = 'stops'
    stop_id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    route_id = db.Column(db.Integer, db.ForeignKey('routes.route_id', ondelete="CASCADE"), nullable=False)
    name = db.Column(db.String(150), nullable=False)
    latitude = db.Column(db.Float, nullable=False)
    longitude = db.Column(db.Float, nullable=False)
    sequence = db.Column(db.Integer, nullable=False, default=1)  # order of stop in route

    # Relationship
    route = db.relationship("Route", backref="stops")

    def __repr__(self):
        return f"<Stop {self.name}>"


# -----------------------
# Tracking Models
# -----------------------
class BusLocation(db.Model):
    __tablename__ = "bus_locations"
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    bus_id = db.Column(db.Integer, nullable=False, unique=True)  # 1 bus -> 1 record
    latitude = db.Column(db.Float, nullable=False)
    longitude = db.Column(db.Float, nullable=False)

    timestamp = db.Column(
        db.DateTime,
        server_default=db.func.current_timestamp(),
        onupdate=db.func.current_timestamp()
    )

    def __repr__(self):
        return f"<BusLocation Bus {self.bus_id} @ {self.latitude},{self.longitude}>"

class Schedule(db.Model):
    __tablename__ = "schedules"

    schedule_id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    route_id = db.Column(db.Integer, db.ForeignKey("routes.route_id", ondelete="CASCADE"), nullable=False)
    bus_id = db.Column(db.Integer, db.ForeignKey("buses.bus_id", ondelete="CASCADE"), nullable=False)
    driver_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    stop_id = db.Column(db.Integer, db.ForeignKey("stops.stop_id", ondelete="CASCADE"), nullable=True)
    arrival_time = db.Column(db.DateTime, nullable=False)
    departure_time = db.Column(db.DateTime, nullable=False)
    status = db.Column(db.String(50), default="on_time")
    current_index = db.Column(db.Integer, default=0)
    date = db.Column(db.String(20), nullable=False)
    is_reached = db.Column(db.Boolean, default=False)

    __table_args__ = (
        db.UniqueConstraint(
            "date", "route_id", "bus_id", "stop_id",
            name="uq_schedule_date_route_bus_stop"
        ),
    )


# -----------------------
# Feedback / Notifications
# -----------------------
class Feedback(db.Model):
    __tablename__ = 'feedback'
    feedback_id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete="CASCADE"), nullable=False)
    message = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=db.func.current_timestamp())

    user = db.relationship("User", backref="feedbacks")

class Notification(db.Model):
    __tablename__ = 'notifications'
    notification_id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete="CASCADE"), nullable=False)
    message = db.Column(db.String(250), nullable=False)
    type = db.Column(db.String(50), nullable=False, default="info")  # info, alert, warning
    timestamp = db.Column(db.DateTime, default=db.func.current_timestamp())
    is_read = db.Column(db.Boolean, default=False)

    user = db.relationship("User", backref="notifications")

# -----------------------
# Roles
# -----------------------
class Role(db.Model):
    __tablename__ = "roles"
    role_id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    role_name = db.Column(db.String(50), unique=True, nullable=False)

class UserRole(db.Model):
    __tablename__ = "user_roles"
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role_id = db.Column(db.Integer, db.ForeignKey("roles.role_id", ondelete="CASCADE"), nullable=False)

    user = db.relationship("User", backref="roles")
    role = db.relationship("Role", backref="users")

# -----------------------
# Driver Documents
# -----------------------
class DriverDocument(db.Model):
    __tablename__ = "driver_documents"
    doc_id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.String(36), db.ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)
    document_type = db.Column(db.String(100), nullable=False)
    document_path = db.Column(db.String(255), nullable=False)
    upload_time = db.Column(db.DateTime, default=db.func.current_timestamp())
    expiry_date = db.Column(db.DateTime, nullable=True)
    is_verified = db.Column(db.Boolean, default=False)

    __table_args__ = (db.UniqueConstraint('user_id', 'document_type', name='_user_document_uc'),)

    user = db.relationship("User", backref="driver_documents")
