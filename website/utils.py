from website.database_utils import db
from website.model import User, Role, UserRole, Notification
from website.extension import socketio
from datetime import datetime

def notify_admins(message, type="info"):
    """
    Sends a notification to all users with the 'SuperAdmin' (or 'Admin') role.
    """
    try:
        # 1. Find the target Role ID (Prefer SuperAdmin, fallback to Admin)
        # Using IN clause to find both, but we prioritize alerting SuperAdmin
        target_roles = Role.query.filter(Role.role_name.in_(["SuperAdmin", "Admin"])).all()
        
        if not target_roles:
            print("⚠️ SuperAdmin/Admin role not found. Cannot send notifications.")
            return

        target_role_ids = [r.role_id for r in target_roles]

        # 2. Find all Users with these Roles
        admins = (
            User.query
            .join(UserRole, User.id == UserRole.user_id)
            .filter(UserRole.role_id.in_(target_role_ids))
            .all()
        )

        if not admins:
            print("⚠️ No SuperAdmins/Admins found to notify.")
            return

        # 3. Create Notification for each Admin
        count = 0
        timestamp_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        for admin in admins:
            notif = Notification(
                user_id=admin.id,
                message=message,
                type=type
            )
            db.session.add(notif)
            # Flush to get ID
            db.session.flush()
            
            # Real-time Push
            try:
                socketio.emit("new_notification", {
                    "id": notif.notification_id,
                    "message": message,
                    "type": type,
                    "timestamp": timestamp_str,
                    "is_read": False
                }, room=f"user_{admin.user_id}")
            except Exception as e:
                print(f"Socket Emit Error: {e}")

            count += 1
        
        db.session.commit()
        print(f"🔔 Notification sent to {count} admin(s): {message}")

    except Exception as e:
        db.session.rollback()
        print(f"❌ Failed to notify admins: {e}")
