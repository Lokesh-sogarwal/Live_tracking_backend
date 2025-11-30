
import os
from functools import wraps
import random
import openrouteservice
import requests
from openrouteservice import convert
from sqlalchemy.exc import IntegrityError
from flask import Blueprint,request,jsonify,session,current_app
from werkzeug.utils import secure_filename
from website.model import *
from  website.auth import token_required,decode_token
import jwt
# from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta


view = Blueprint('view',__name__)
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "pdf", "docx"}
ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImU2YTdlOGMyODhmYjQwMDRhYzNlNjRhYWJmODJmN2UyIiwiaCI6Im11cm11cjY0In0="
client = openrouteservice.Client(key=ORS_API_KEY)
def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS

@view.route('/user_details', methods=['GET'])
@token_required
def users_detail():
    auth_header = request.headers.get('Authorization')
    if not auth_header:
        return jsonify({'error': 'Authorization header missing'}), 401

    users = User.query.all()
    if users:
        users_list = []
        for user in users:
            # Get the user's role
            role_entry = UserRole.query.filter_by(user_id=user.id).first()
            role = None
            if role_entry:
                role_obj = Role.query.filter_by(role_id=role_entry.role_id).first()
                role = role_obj.role_name if role_obj else None

            # ✅ Skip users with role Driver
            if role == "Driver":
                continue

            # ✅ Only append if not Driver
            users_list.append({
                "user_uuid": user.user_id,
                "fullname": user.fullname,
                "email": user.email,
                "fathername": getattr(user, "father_name", ""),
                "mothername": getattr(user, "mother_name", ""),
                "phone_no": user.phone_no,
                "role": role
            })
        return jsonify(users_list)

    return jsonify([])


@view.route('/profile', methods=['GET', 'PUT'])
@token_required
def profile():
    auth_header = request.headers.get('Authorization')
    if not auth_header:
        return jsonify({'error': 'Authorization header missing'}), 401

    try:
        token = auth_header.split(" ")[1]  # Bearer <token>
        user_id = decode_token(token)

        user = User.query.filter_by(user_id=user_id).first()
        if not user:
            return jsonify({'error': 'User not found'}), 404

        role_entry = UserRole.query.filter_by(user_id=user.id).first()
        # print(role_entry)

        if role_entry:
            role_obj = Role.query.filter_by(role_id=role_entry.role_id).first()
            # print(role_obj)
            role = role_obj.role_name if role_obj else None

        if request.method == 'GET':
            return jsonify({
                'fullname': user.fullname,
                'email': user.email,
                # 'dob': user.dob,
                # 'fathername': user.father_name,
                # 'mothername': user.mother_name,
                'role': role,
                'phone_no': user.phone_no
            }), 200

        elif request.method == 'PUT':
            data = request.get_json()
            user.fullname = data.get('fullname', user.fullname)
            user.email = data.get('email', user.email)
            user.dob = data.get('dob', user.dob)
            user.father_name = data.get('fathername', user.father_name)
            user.mother_name = data.get('mothername', user.mother_name)

            db.session.commit()

            return jsonify({
                'fullname': user.fullname,
                'email': user.email,
                'dob': user.dob,
                'fathername': user.father_name,
                'mothername': user.mother_name,
                'phone_no': user.phone_no
            }), 200

    except jwt.ExpiredSignatureError:
        return jsonify({'error': 'Token expired'}), 401
    except jwt.InvalidTokenError:
        return jsonify({'error': 'Invalid token'}), 401


@view.route('/delete', methods=['POST'])
@token_required
def delete_user():
    data = request.get_json()
    user_uuid = data.get('user_uuid')
    if not user_uuid:
        return jsonify({"error": "Please provide User UUID"}), 400

    user = User.query.filter_by(user_id=user_uuid).first()
    if not user:
        return jsonify({"error": "User not found"}), 404

    db.session.delete(user)
    db.session.commit()
    return jsonify({"message": f"User {user_uuid} deleted successfully"}), 200


@view.route('/edit_user_details', methods=['POST'])
@token_required
def edit_user():
    data = request.get_json()
    user_uuid = data.get('user_uuid')
    print(user_uuid)
    if not user_uuid:
        return jsonify({"error": "Please provide User UUID"}), 400

    user = User.query.filter_by(user_id=user_uuid).first()
    if not user:
        return jsonify({"error": "User not found"}), 404

    user.fullname = data.get('fullname', user.fullname)
    user.email = data.get('email', user.email)
    user.dob = data.get('dob', user.dob)
    user.father_Name = data.get('fathername', user.father_Name)
    user.mother_name = data.get('mothername', user.mother_name)

    db.session.commit()
    return jsonify({
        'fullname': user.fullname,
        'email': user.email,
        'dob': user.dob,
        'fathername': user.father_Name,
        'mothername': user.mother_name
    }), 200

@view.route('/driver_details', methods=['GET'])
@token_required
def driver_detail():
    auth_header = request.headers.get('Authorization')
    if not auth_header:
        return jsonify({'error': 'Authorization header missing'}), 401

    users = User.query.all()
    if users:
        users_list = []
        for user in users:
            # Get the user's role
            role_entry = UserRole.query.filter_by(user_id=user.id).first()
            role = None
            if role_entry:
                role_obj = Role.query.filter_by(role_id=role_entry.role_id).first()
                role = role_obj.role_name if role_obj else None

            # ✅ Skip users with role Driver
            if role == "driver":
            # ✅ Only append if not Driver
                users_list.append({
                    "user_uuid": user.user_id,
                    "fullname": user.fullname,
                    "email": user.email,
                    "fathername": getattr(user, "father_name", ""),
                    "mothername": getattr(user, "mother_name", ""),
                    "phone_no": user.phone_no,
                    "role": role
                })
        return jsonify(users_list)

    return jsonify([])
@view.route('/upload/<string:user_id>', methods=['POST'])
@token_required
def upload_document(user_id):
    auth_header = request.headers.get('Authorization')
    if not auth_header:
        return jsonify({'error': 'Authorization header missing'}), 401

    if 'file' not in request.files:
        return jsonify({"error": "No file part in request"}), 400

    file = request.files['file']
    document_type = request.form.get('document_type', 'general')
    expiry_date_str = request.form.get('expiry_date')  # optional

    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400

    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        # ensure unique filename per user
        ext = os.path.splitext(filename)[1]
        unique_filename = f"{user_id}_{document_type}{ext}"
        save_path = os.path.join(current_app.config['UPLOAD_FOLDER'], unique_filename)

        os.makedirs(current_app.config['UPLOAD_FOLDER'], exist_ok=True)
        file.save(save_path)

        # Parse expiry date
        expiry_date = None
        if expiry_date_str:
            try:
                expiry_date = datetime.strptime(expiry_date_str, "%Y-%m-%d")
            except ValueError:
                return jsonify({"error": "Invalid expiry date format, use YYYY-MM-DD"}), 400

        # Save to DB
        new_doc = DriverDocument(
            user_id=user_id,
            document_type=document_type,
            document_path=save_path,
            expiry_date=expiry_date
        )
        db.session.add(new_doc)
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            return jsonify({"error": f"{document_type} already exists for this user"}), 400

        return jsonify({"message": "File uploaded successfully", "filename": unique_filename}), 201

    return jsonify({"error": "Invalid file type"}), 400

@view.route("/update_location", methods=["POST"])
@token_required
def update_location():
    data = request.get_json()
    bus_id = data.get("bus_id")
    latitude = data.get("latitude")
    longitude = data.get("longitude")

    if bus_id is None or latitude is None or longitude is None:
        return jsonify({"error": "Missing data"}), 400

    try:
        latitude = float(latitude)
        longitude = float(longitude)
        bus_id = int(bus_id)

        loc = BusLocation.query.filter_by(bus_id=bus_id).first()
        if loc:
            loc.latitude = latitude
            loc.longitude = longitude
        else:
            loc = BusLocation(bus_id=bus_id, latitude=latitude, longitude=longitude)
            db.session.add(loc)

        db.session.commit()
        return jsonify({"message": "Location updated"})
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": str(e)}), 500



@view.route("/get_location/<int:bus_id>", methods=["GET"])
@token_required
def get_location(bus_id):
    # auth_header = request.headers.get('Authorization')
    # if not auth_header:
    #     return jsonify({'error': 'Authorization header missing'}), 401

    loc = BusLocation.query.filter_by(bus_id=bus_id).first()
    if loc:
        return jsonify({
            "latitude": loc.latitude,
            "longitude": loc.longitude,
            "timestamp": loc.timestamp
        })
    return jsonify({"error": "No location found"}), 404


@view.route("/api/get_route/<float:start_lat>/<float:start_lng>/<float:end_lat>/<float:end_lng>")
@token_required
def get_route(start_lat, start_lng, end_lat, end_lng):
    try:
        coords = [[start_lng, start_lat], [end_lng, end_lat]]

        # Request route from ORS
        route_data = client.directions(
            coordinates=coords,
            profile='driving-car',
            instructions=False,
            format='json'
        )

        # Decode polyline to get coordinates array
        geom_str = route_data['routes'][0]['geometry']  # This is a string
        decoded = convert.decode_polyline(geom_str)

        # Replace geometry with dict
        route_data['routes'][0]['geometry'] = {
            "type": "LineString",
            "coordinates": decoded['coordinates']
        }

        return jsonify(route_data)

    except Exception as e:
        return jsonify({"error": str(e)}), 400


@view.route('/submit_feedback',methods=["POST"])
@token_required
def submit_feedback():
    auth_header = request.headers.get('Authorization')
    if not auth_header:
        return jsonify({"Error","Token not verified"})

    token = auth_header.split(" ")[1]  # Bearer <token>
    user_id = decode_token(token)

    user = User.query.filter_by(user_id =user_id).first()
    current_user_id = user.id
    current_user_email = user.email

    if not current_user_id or not current_user_email:
        return jsonify({"error": "User not logged in"}), 401

    data = request.get_json()
    feedback = data.get('feedback')

    new_feed = Feedback(
        user_id = current_user_id,
        email = current_user_email,
        message = feedback
    )
    db.session.add(new_feed)
    db.session.commit()
    if not feedback:
        return jsonify({"error":"feedback is required"})

    return jsonify({"Feedback":feedback
    , "User":current_user_id,"email":current_user_email})