from flask import Blueprint,request,jsonify
from website.model import *


get_data =Blueprint('get_data',__name__)

@get_data.route('/get_data', methods=['GET'])
def fetch_data():  # ✅ Renamed function to avoid conflict
    users = User.query.all()
    active_users = Active_user.query.all()
    total_drivers = db.session.query(User).join(
        UserRole, User.id == UserRole.user_id
    ).join(
        Role, UserRole.role_id == Role.role_id
    ).filter(
        Role.role_name == 'driver'
    ).count()

    # Serialize user objects
    users_data = []
    active_data = []

    for user in users:
        users_data.append({
            'id': user.id,
            'fullname': user.fullname,
            'email': user.email,
            'created_date': user.date_created
        })

    for active_user in active_users:
        active_data.append({
            'id': active_user.user_id,
            'login_time': active_user.login_time,
            'fullname': active_user.fullname,
            'email': active_user.email,
            'role': active_user.role
        })

    # ✅ Return a structured JSON object
    return jsonify({
        "users": users_data,
        "total_users": len(users),
        "total_active_users": len(active_users),
        "active_users": active_data,
        "total_driver": total_drivers
    }), 200

@get_data.route('/total_routes', methods=["GET"])
def total_routes():
    auth_header = request.headers.get('Authorization')
    if not auth_header:
        return jsonify({'error': 'Authorization header missing'}), 401

    try:
        # 📊 Counts
        total_routes = Schedule.query.count()
        completed_routes = Schedule.query.filter_by(is_reached=True).count()

        # 🧾 Fetch all schedules
        schedules = Schedule.query.all()

        # 🧠 Convert SQLAlchemy objects to JSON-friendly dicts
        schedules_data = [
            {
                "schedule_id": sch.schedule_id,
                "route_id": sch.route_id,
                "bus_id": sch.bus_id,
                "driver_id": sch.driver_id,
                "stop_id": sch.stop_id,
                "arrival_time": sch.arrival_time.strftime("%Y-%m-%d %H:%M:%S") if sch.arrival_time else None,
                "departure_time": sch.departure_time.strftime("%Y-%m-%d %H:%M:%S") if sch.departure_time else None,
                "status": sch.status,
                "current_index": sch.current_index,
                "date": sch.date,
                "is_reached": bool(sch.is_reached)
            }
            for sch in schedules
        ]

        # ✅ Return all info as JSON
        return jsonify({
            "total_routes": total_routes,
            "route_completed": completed_routes,
            "schedules": schedules_data
        }), 200

    except Exception as e:
        print("❌ Error in /total_routes:", e)
        return jsonify({'error': f'Error getting routes: {str(e)}'}), 500
