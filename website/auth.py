from functools import wraps

from flask import Blueprint,request,jsonify,session,current_app
from website.model import *
from website.utils import notify_admins
import jwt
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta

auth = Blueprint('auth',__name__)
def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        # Allow CORS preflight requests to succeed without auth.
        if request.method == "OPTIONS":
            return jsonify({"ok": True}), 200

        auth_header = request.headers.get('Authorization')
        if not auth_header:
            return jsonify({"error": "Authorization header missing"}), 401

        try:
            parts = auth_header.split(" ")
            if len(parts) != 2 or parts[0].lower() != "bearer":
                return jsonify({"error": "Invalid Authorization header format"}), 401
            
            token = parts[1]  # "Bearer token"
            decoded = jwt.decode(token, current_app.config['SECRET_KEY'], algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            return jsonify({"error": "Token expired"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"error": "Invalid token"}), 401
        except Exception as e:
            return jsonify({"error": f"Token error: {str(e)}"}), 401

        return f(*args, **kwargs)
    return decorated


def decode_token(token):
    payload = jwt.decode(token, current_app.config['SECRET_KEY'], algorithms=["HS256"])
    user_id = payload['user_id']
    return user_id


def decode_token_payload(token):
    return jwt.decode(token, current_app.config['SECRET_KEY'], algorithms=["HS256"])

@auth.route('/login', methods=["POST"])
def login():
    try:
        data = request.get_json(silent=True)
        if not data:
             return jsonify({'error': 'Invalid JSON or Content-Type header'}), 400

        email = data.get('email')
        password = data.get('password')

        if not email or not password:
            return jsonify({'error': 'Email and password are required'}), 400

        # 1. Fetch user safely
        user = User.query.filter_by(email=email).first()
        if not user:
            return jsonify({'error': 'Invalid credentials'}), 401

        # 2. Check if password matches
        if not check_password_hash(user.password, password):
            return jsonify({'error': 'Invalid credentials'}), 401

        # 3. Role fetch safely
        role_entry = UserRole.query.filter_by(user_id=user.id).first()
        role_obj = Role.query.filter_by(role_id=role_entry.role_id).first() if role_entry else None
        role_name = role_obj.role_name if role_obj else "Passenger"

        # 4. If already logged in → remove previous active record
        active_user = Active_user.query.filter_by(user_id=user.id).first()
        if active_user:
            db.session.delete(active_user)
            db.session.commit()

        # 5. Create JWT token
        token_payload = {
            'user_id': user.user_id,
            'is_password_change': user.is_password_change,
            'role': role_name,
            'exp': datetime.utcnow() + timedelta(hours=3)
        }

        token = jwt.encode(
            token_payload,
            current_app.config['SECRET_KEY'],
            algorithm='HS256'
        )

        # 6. Add to Active_user always (not only after password change)
        new_active = Active_user(
            user_id=user.id,
            email=user.email,
            fullname=user.fullname,
            role=role_name
        )
        db.session.add(new_active)
        db.session.commit()

        # 7. Store session
        session['email'] = user.email
        session['user_id'] = user.id
        session['role'] = role_name

        return jsonify({'token': token}), 200

    except Exception as e:
        print(f"Login Error: {str(e)}")
        return jsonify({'error': 'Internal Server Error'}), 500

    except Exception as e:
        db.session.rollback()
        print("❌ Login Error:")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@auth.route("/logout", methods=["POST"])
@token_required
def logout():
    auth_header = request.headers.get('Authorization')
    # already validated by token_required
    token = auth_header.split(" ")[1]

    try:
        token_user_id = decode_token(token)
    except Exception as e:
        return jsonify({"error": f"Invalid token: {str(e)}"}), 401

    # Find user by UUID from token instead of session email
    user = User.query.filter_by(user_id=token_user_id).first()

    if not user:
        return jsonify({"error": "User does not exist"}), 404

    active_user = Active_user.query.filter_by(user_id=user.id).first()
    
    if active_user:
        db.session.delete(active_user)
        db.session.commit()
    
    # clear session cookie if it exists (hybrid approach)
    session.clear()

    print(f"User {user.fullname} logged out successfully (id: {user.user_id})")

    return jsonify({"message": "Logged out successfully"}), 200




@auth.route('/signup',methods=['POST'])
def signup():
    data = request.get_json()
    fullname = data.get('fullname')
    email = data.get('email')
    password = data.get('password')
    is_password_change = data.get('is_password_change');
    role_name = data.get('role')

    if not email or not password or not fullname:
        return jsonify({'error': 'fullname,Email and password are required'}), 400
    if not role_name :
        return jsonify({"Error":"Role is required"})

    existing_user = User.query.filter_by(email=email).first()
    if existing_user:
        return jsonify({'error':'User already exist !!'})
    hash_password = generate_password_hash(password)
    new_user = User(fullname= fullname,email=email,password=hash_password,is_password_change=is_password_change)
    try:
        db.session.add(new_user)
        db.session.commit()
        role = Role.query.filter_by(role_name=role_name).first()
        if role:
            print(role)
            user_role = UserRole(user_id=new_user.id, role_id=role.role_id)
            db.session.add(user_role)
            db.session.commit()

            # 🔔 Notify Admin
            notify_admins(f"New User Registered: {fullname} ({email}) as {role_name}", type="info")

            return jsonify({'message':'User and Role assigned Succesfully'}),200

    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

