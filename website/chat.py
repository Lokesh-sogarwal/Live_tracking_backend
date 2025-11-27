# chat.py
from flask import Blueprint, jsonify, request
from flask_socketio import SocketIO, emit, join_room, leave_room
from website.extension import db, socketio
from .modal import ChatMessage, User
from .auth import decode_token

chat = Blueprint("chat", __name__)

def get_room_id(user1_id, user2_id):
    return "_".join(sorted([str(user1_id), str(user2_id)]))

def save_message(sender_id, receiver_id, message):
    sender = User.query.filter_by(user_id=sender_id).first()
    receiver = User.query.filter_by(user_id=receiver_id).first()
    if not sender or not receiver:
        raise ValueError("Sender or Receiver does not exist!")

    msg = ChatMessage(sender_id=sender_id, receiver_id=receiver_id, message=message)
    db.session.add(msg)
    db.session.commit()

# ----------------- SocketIO Events -----------------
@socketio.on("join")
def handle_join(data):
    sender_id = data["sender_id"]
    receiver_id = data["receiver_id"]
    room = get_room_id(sender_id, receiver_id)
    join_room(room)
    emit("message", {"msg": f"{data['username']} has entered the chat."}, room=room)

@socketio.on("send_message")
def handle_message(data):
    sender_id = data["sender_id"]
    receiver_id = data["receiver_id"]
    message = data["msg"]
    room = get_room_id(sender_id, receiver_id)

    save_message(sender_id, receiver_id, message)
    emit("message", {"sender_id": sender_id, "msg": message}, room=room)

@socketio.on("leave")
def handle_leave(data):
    sender_id = data["sender_id"]
    receiver_id = data["receiver_id"]
    room = get_room_id(sender_id, receiver_id)
    leave_room(room)
    emit("message", {"msg": f"{data['username']} has left the chat."}, room=room)

# ----------------- Chat History -----------------
@chat.route("/history/<other_user_id>", methods=["GET"])
def get_chat_history(other_user_id):
    auth_header = request.headers.get("Authorization")
    if not auth_header or " " not in auth_header:
        return jsonify({"error": "Missing or invalid Authorization header"}), 401

    token = auth_header.split(" ")[1]
    user_id = decode_token(token)
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    messages = ChatMessage.query.filter(
        ((ChatMessage.sender_id == user_id) & (ChatMessage.receiver_id == other_user_id)) |
        ((ChatMessage.sender_id == other_user_id) & (ChatMessage.receiver_id == user_id))
    ).order_by(ChatMessage.timestamp.asc()).all()

    messages_list = [
        {"sender_id": msg.sender_id, "receiver_id": msg.receiver_id, "msg": msg.message, "timestamp": msg.timestamp.isoformat()}
        for msg in messages
    ]
    return jsonify(messages_list)
