import os
from functools import wraps
import random
import requests
from sqlalchemy.exc import IntegrityError
from flask import Blueprint,request,jsonify,session,current_app
from werkzeug.utils import secure_filename
from website.model import *
from  website.auth import token_required,decode_token
import jwt
# from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta

get_data =Blueprint('get_data',__name__)

@get_data.route('/get_data', methods=['GET'])
def fetch_data():  # ✅ Renamed function to avoid conflict
    users = User.query.all()
    active_users = Active_user.query.all()

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
        "active_users": active_data
    }), 200

@get_data.route('/total_routes', methods=["GET"])
def total_routes():
    auth_header = request.headers.get('Authorization')
    if not auth_header:
        return jsonify({'error': 'Authorization header missing'}), 401
    try:
        total_routes = Schedule.query.count()  # faster than fetching all
        completed_routes = Schedule.query.filter_by(is_reached=True).count()

        return jsonify({
            "total_routes": total_routes,
            "route_completed": completed_routes
        }), 200
    except Exception as e:
        return jsonify({'error': f'Error getting routes: {str(e)}'}), 500



