from flask import Blueprint,request,jsonify,send_from_directory
from website.model import *
from website.auth import token_required
import  os

get_data =Blueprint('get_data',__name__)

UPLOAD_FOLDER = os.path.join(os.getcwd(), "uploads")
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

@get_data.route('/get_data', methods=['GET'])
@token_required
def fetch_data():
    try:
        # 🧩 Fetch all users efficiently (only required columns)
        users_query = db.session.query(User.id, User.fullname, User.email, User.date_created).all()
        
        # 🔥 Fetch active users efficiently
        active_users_query = db.session.query(
            Active_user.user_id, 
            Active_user.login_time, 
            Active_user.fullname, 
            Active_user.email, 
            Active_user.role
        ).all()

        # 🚌 Total drivers (Count directly in DB)
        total_drivers = (
            db.session.query(db.func.count(User.id))
            .join(UserRole, User.id == UserRole.user_id)
            .join(Role, UserRole.role_id == Role.role_id)
            .filter(Role.role_name == 'driver')
            .scalar()
        )

        # 🚌 Total buses
        total_buses = db.session.query(db.func.count(Bus.bus_id)).scalar()

        # 👥 Serialize user data
        users_data = [{
            'id': u.id,
            'fullname': u.fullname,
            'email': u.email,
            'created_date': u.date_created.strftime("%Y-%m-%d") if u.date_created else None
        } for u in users_query]

        # 🔥 Serialize active users data
        active_data = [{
            'id': au.user_id,
            'login_time': au.login_time.strftime("%Y-%m-%d %H:%M:%S") if au.login_time else None,
            'fullname': au.fullname,
            'email': au.email,
            'role': au.role
        } for au in active_users_query]

        # ✅ Return structured JSON response
        return jsonify({
            "users": users_data,
            "total_users": len(users_query),
            "total_active_users": len(active_users_query),
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
@token_required
def total_routes():
    # auth header validated by token_required

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
@token_required
def uploaded_documents():
    # auth header validated by token_required

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
        # return jsonify({'error': 'Not a valid token'}), 401
        pass # Allow access for now or handle appropriately

    # 🚀 Optimized Query: Join Feedback with User to avoid N+1 problem
    # Instead of N queries inside loop, we do 1 query with JOIN.
    results = (
        db.session.query(Feedback, User)
        .outerjoin(User, Feedback.user_id == User.id)
        .order_by(Feedback.timestamp.desc())
        .all()
    )

    feed_list = []
    for feedback, user in results:
        feed_list.append({
            'user_name': user.fullname if user else "Unknown",
            'email': feedback.email,
            'feedback': feedback.message,
            'created_at': feedback.timestamp.strftime("%Y-%m-%d %H:%M:%S") if feedback.timestamp else None
        })

    return jsonify(feed_list), 200

