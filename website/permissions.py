from flask import Blueprint, request, jsonify, current_app
import jwt

from website.database_utils import db
from website.model import Role, RolePermission
from website.auth import token_required, decode_token_payload


permissions = Blueprint("permissions", __name__)


def _get_bearer_token():
    auth_header = request.headers.get("Authorization")
    if not auth_header:
        return None
    parts = auth_header.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1]


def _get_requester_role():
    token = _get_bearer_token()
    if not token:
        return None
    payload = decode_token_payload(token)
    role = payload.get("role")
    return role


def superadmin_required(f):
    def wrapper(*args, **kwargs):
        try:
            role = _get_requester_role()
            if not role or role.strip().lower() != "superadmin":
                return jsonify({"error": "Unauthorized: Superadmin only"}), 403
        except jwt.ExpiredSignatureError:
            return jsonify({"error": "Token expired"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"error": "Invalid token"}), 401
        return f(*args, **kwargs)
    
    wrapper.__name__ = f.__name__
    return wrapper


@permissions.route("/roles", methods=["GET"])
@token_required
@superadmin_required
def list_roles():
    roles = Role.query.order_by(Role.role_name.asc()).all()
    return jsonify([{"role_id": r.role_id, "role_name": r.role_name} for r in roles]), 200


@permissions.route("/matrix", methods=["GET"])
@token_required
@superadmin_required
def get_permissions_matrix():
    roles = Role.query.all()
    perms = RolePermission.query.all()

    matrix = {r.role_name: {} for r in roles}

    # Only include explicit settings; missing keys are treated as allowed by frontend.
    role_by_id = {r.role_id: r.role_name for r in roles}
    for p in perms:
        role_name = role_by_id.get(p.role_id)
        if not role_name:
            continue
        matrix.setdefault(role_name, {})[p.feature_key] = bool(p.allowed)

    return jsonify({"roles": [r.role_name for r in roles], "matrix": matrix}), 200


@permissions.route("/matrix", methods=["PUT"])
@token_required
@superadmin_required
def update_permissions_matrix():
    data = request.get_json(silent=True) or {}

    # Expected payload:
    # { "updates": [ {"role_name": "Admin", "feature_key": "users", "allowed": true}, ... ] }
    updates = data.get("updates")
    if not isinstance(updates, list) or not updates:
        return jsonify({"error": "updates must be a non-empty list"}), 400

    roles = Role.query.all()
    role_by_name = {r.role_name: r for r in roles}

    try:
        for item in updates:
            if not isinstance(item, dict):
                continue

            role_name = item.get("role_name")
            feature_key = item.get("feature_key")
            allowed = item.get("allowed")

            if not role_name or not feature_key or allowed is None:
                continue

            role = role_by_name.get(role_name)
            if not role:
                continue

            perm = RolePermission.query.filter_by(role_id=role.role_id, feature_key=feature_key).first()
            if perm:
                perm.allowed = bool(allowed)
            else:
                db.session.add(
                    RolePermission(role_id=role.role_id, feature_key=feature_key, allowed=bool(allowed))
                )

        db.session.commit()
        return jsonify({"message": "Permissions updated"}), 200

    except Exception as e:
        db.session.rollback()
        current_app.logger.exception("Failed updating permissions")
        return jsonify({"error": str(e)}), 500


@permissions.route("/my", methods=["GET"])
@token_required
def my_permissions():
    # Returns explicit permissions for the current user's role.
    # Frontend should treat missing keys as allowed (to preserve existing behavior).
    token = _get_bearer_token()
    if not token:
        return jsonify({"error": "Authorization header missing"}), 401

    try:
        payload = decode_token_payload(token)
        role_name = payload.get("role")
        if not role_name:
            return jsonify({"role": None, "permissions": {}}), 200

        role = Role.query.filter_by(role_name=role_name).first()
        if not role:
            return jsonify({"role": role_name, "permissions": {}}), 200

        perms = RolePermission.query.filter_by(role_id=role.role_id).all()
        return jsonify(
            {
                "role": role_name,
                "permissions": {p.feature_key: bool(p.allowed) for p in perms},
            }
        ), 200

    except jwt.ExpiredSignatureError:
        return jsonify({"error": "Token expired"}), 401
    except jwt.InvalidTokenError:
        return jsonify({"error": "Invalid token"}), 401
