from flask import Blueprint,request,jsonify,send_from_directory
from website.model import *
import  os

get_data =Blueprint('get_data',__name__)

UPLOAD_FOLDER = os.path.join(os.getcwd(), "uploads")
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

@get_data.route('/get_data', methods=['GET'])
def fetch_data():
    try:
        # 🧩 Fetch all users and active users
        users = User.query.all()
        active_users = Active_user.query.all()

        # 🚌 Total drivers
        total_drivers = (
            db.session.query(User)
            .join(UserRole, User.id == UserRole.user_id)
            .join(Role, UserRole.role_id == Role.role_id)
            .filter(Role.role_name == 'driver')
            .count()
        )

        # 🚌 Total buses (use count() instead of .all())
        total_buses = Bus.query.count()

        # 👥 Serialize user data
        users_data = [{
            'id': user.id,
            'fullname': user.fullname,
            'email': user.email,
            'created_date': user.date_created.strftime("%Y-%m-%d") if hasattr(user.date_created, 'strftime') else user.date_created
        } for user in users]

        # 🔥 Serialize active users data
        active_data = [{
            'id': active_user.user_id,
            'login_time': active_user.login_time.strftime("%Y-%m-%d %H:%M:%S") if hasattr(active_user.login_time, 'strftime') else active_user.login_time,
            'fullname': active_user.fullname,
            'email': active_user.email,
            'role': active_user.role
        } for active_user in active_users]

        # ✅ Return structured JSON response
        return jsonify({
            "users": users_data,
            "total_users": len(users),
            "total_active_users": len(active_users),
            "active_users": active_data,
            "total_driver": total_drivers,
            "total_buses": total_buses
        }), 200

    except Exception as e:
        print("[ERROR] fetch_data Exception:", str(e))
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


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




@get_data.route('/get_documents', methods=["GET"])
def uploaded_documents():
    auth_header = request.headers.get("Authorization")

    if not auth_header:
        return jsonify({"error": "Authorization token missing"}), 401

    try:
        # Fetch all uploaded documents
        documents = DriverDocument.query.all()
        if not documents:
            return jsonify({"message": "No documents found"}), 404

        uploads = []
        for doc in documents:
            # Keep the relative path from uploads folder
            filename = os.path.relpath(doc.document_path, UPLOAD_FOLDER).replace("\\", "/")
            uploads.append({
                "id": doc.doc_id,
                "driver_id": doc.user_id,
                "document_name": doc.document_type,
                "document_path": filename,  # relative path inside uploads
                "uploaded_at": doc.upload_time.strftime("%Y-%m-%d %H:%M:%S") if doc.upload_time else None,
                "status": getattr(doc, "status", "pending"),  # optional: verified/rejected
                "is_verified":doc.is_verified,
                "is_rejected":doc.is_rejected
            })

        return jsonify({"total_documents": len(uploads), "documents": uploads}), 200

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@get_data.route('/uploads/<path:filename>', methods=['GET'])
def serve_uploaded_file(filename):
    """Serve any file inside the uploads folder."""
    try:
        return send_from_directory(UPLOAD_FOLDER, filename)
    except Exception as e:
        print("[ERROR] serving file:", e)
        return jsonify({"error": "File not found"}), 404


# Optional: Verify/Reject endpoints
@get_data.route("/verify_document/<int:doc_id>", methods=["POST"])
def verify_document(doc_id):
    doc = DriverDocument.query.get(doc_id)
    if not doc:
        return jsonify({"error": "Document not found"}), 404
    doc.status = "verified"
    doc.is_verified = True
    db.session.commit()
    return jsonify({"message": "Document verified"}), 200

@get_data.route("/reject_document/<int:doc_id>", methods=["POST"])
def reject_document(doc_id):
    doc = DriverDocument.query.get(doc_id)
    if not doc:
        return jsonify({"error": "Document not found"}), 404
    doc.status = "rejected"
    doc.is_rejected  = True
    db.session.commit()
    return jsonify({"message": "Document rejected"}), 200


@get_data.route('/get_feedback', methods=["GET"])
def get_feedbacks():
    auth_header = request.headers.get('Authorization')

    if not auth_header:
        return jsonify({'error': 'Not a valid token'}), 401

    feedbacks = Feedback.query.all()
    feed_list = []

    for feedback in feedbacks:
        # Match Feedback.user_id with User.id
        user = User.query.filter_by(id=feedback.user_id).first()

        feed_list.append({
            'user_name': user.fullname if user else "Unknown",  # fallback if user is None
            'email': feedback.email,
            'feedback': feedback.message,
            'created_at': feedback.timestamp.strftime("%Y-%m-%d %H:%M:%S") if feedback.timestamp else None
        })

    return jsonify(feed_list), 200

