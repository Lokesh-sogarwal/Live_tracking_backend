# chat.py
import jwt
from flask import Blueprint, jsonify, request
from flask_socketio import emit, join_room, leave_room
from website.extension import db, socketio
from website.model import ChatMessage, User
from website.auth import decode_token

chat = Blueprint("chat", __name__)

SECRET_KEY = "--Hackathon@inovatrix@-@2580#1234--"


# =====================================================
# Generate consistent room ID between two users (UUID)
# =====================================================
def get_room_id(user1_id, user2_id):
    return "_".join(sorted([str(user1_id), str(user2_id)]))


# =====================================================
# Save chat message to database
# =====================================================
def save_message(sender_id, receiver_id, message):
    sender = User.query.filter_by(user_id=sender_id).first()
    receiver = User.query.filter_by(user_id=receiver_id).first()

    if not sender or not receiver:
        print("Sender:", sender_id, "Receiver:", receiver_id)
        raise ValueError("Sender or Receiver does not exist!")

    msg = ChatMessage(
        sender_id=sender_id,
        receiver_id=receiver_id,
        message=message
    )
    db.session.add(msg)
    db.session.commit()


# =====================================================
# SOCKET.IO EVENTS
# =====================================================

@socketio.on("join")
def handle_join(data):
    sender_id = data["sender_id"]         # UUID
    receiver_id = data["receiver_id"]     # UUID
    room = get_room_id(sender_id, receiver_id)

    join_room(room)

    emit("message",
         {"msg": f"{data['username']} joined the chat."},
         room=room)


@socketio.on("send_message")
def handle_send_message(data):
    sender_id = data["sender_id"]       # UUID
    receiver_id = data["receiver_id"]   # UUID
    message = data["msg"]

    room = get_room_id(sender_id, receiver_id)

    # Save to DB
    save_message(sender_id, receiver_id, message)

    # Broadcast message to room
    emit("message",
         {
             "sender_id": sender_id,
             "receiver_id": receiver_id,
             "msg": message,
         },
         room=room)


@socketio.on("leave")
def handle_leave(data):
    sender_id = data["sender_id"]
    receiver_id = data["receiver_id"]
    room = get_room_id(sender_id, receiver_id)

    leave_room(room)

    emit("message",
         {"msg": f"{data['username']} left the chat."},
         room=room)


# =====================================================
# CHAT HISTORY API
# =====================================================
@chat.route("/history/<other_user_id>", methods=["GET"])
def get_chat_history(other_user_id):
    # -------------------------
    # 1. Read Authorization
    # -------------------------
    auth_header = request.headers.get("Authorization")
    if not auth_header or " " not in auth_header:
        return jsonify({"error": "Missing or invalid Authorization header"}), 401

    token = auth_header.split(" ")[1]

    # -------------------------
    # 2. Decode token safely
    # decode_token returns user_id (UUID)
    # -------------------------
    user_id = decode_token(token)

    if not user_id:
        return jsonify({"error": "Invalid or expired token"}), 401

    # -------------------------
    # 3. Verify both users exist
    # -------------------------
    me = User.query.filter_by(user_id=user_id).first()
    other_user = User.query.filter_by(user_id=other_user_id).first()

    if not me:
        return jsonify({"error": "Your user account not found"}), 404

    if not other_user:
        return jsonify({"error": "The user you're chatting with does not exist"}), 404

    # -------------------------
    # 4. Fetch messages between both users
    # -------------------------
    messages = ChatMessage.query.filter(
        ((ChatMessage.sender_id == user_id) &
         (ChatMessage.receiver_id == other_user_id)) |
        ((ChatMessage.sender_id == other_user_id) &
         (ChatMessage.receiver_id == user_id))
    ).order_by(ChatMessage.timestamp.asc()).all()

    # -------------------------
    # 5. Format output
    # -------------------------
    messages_list = [
        {
            "sender_id": msg.sender_id,
            "receiver_id": msg.receiver_id,
            "msg": msg.message,
            "timestamp": msg.timestamp.isoformat()
        }
        for msg in messages
    ]

    return jsonify(messages_list)
