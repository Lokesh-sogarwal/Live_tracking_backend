# chat.py
import jwt
from flask import Blueprint, jsonify, request
from flask_socketio import emit, join_room, leave_room
from sqlalchemy.exc import IntegrityError
from sqlalchemy import or_, and_
from website.extension import db, socketio
from website.model import ChatMessage, User
from website.auth import decode_token, token_required

chat = Blueprint("chat", __name__)

# =====================================================
# Generate consistent room ID between two users (UUID)
# =====================================================
def get_room_id(user1_id, user2_id):
    # Sort UUIDs so the room ID is always the same for pair (A, B)
    return "_".join(sorted([str(user1_id), str(user2_id)]))


# =====================================================
# SOCKET.IO EVENTS
# =====================================================

@socketio.on("join")
def handle_join(data):
    """
    User joins a chat room with another user.
    emits 'history' event with recent messages for context.
    """
    try:
        sender_id = data.get("sender_id")         # UUID
        receiver_id = data.get("receiver_id")     # UUID
        username = data.get("username", "User")
        
        if not sender_id or not receiver_id:
            return

        room = get_room_id(sender_id, receiver_id)
        join_room(room)
        
        # print(f"User {username} ({sender_id}) joined room {room}")

        # OPTIMIZATION: Emit status only to others, not back to sender? 
        # Actually standard chat "User joined" is often noise. 
        # Uncomment if you want join notifications.
        # emit("message", {"msg": f"{username} online"}, room=room)

    except Exception as e:
        print(f"Error in handle_join: {e}")


@socketio.on("send_message")
def handle_send_message(data):
    try:
        sender_id = data.get("sender_id")       # UUID
        receiver_id = data.get("receiver_id")   # UUID
        message = data.get("msg")
        
        if not sender_id or not receiver_id or not message:
            return

        room = get_room_id(sender_id, receiver_id)

        # OPTIMIZATION: Insert directly without 2 pre-check SELECT queries.
        # Foreign Key constraints ensure validity.
        try:
            msg = ChatMessage(
                sender_id=sender_id,
                receiver_id=receiver_id,
                message=message
            )
            db.session.add(msg)
            db.session.commit()

            # Broadcast message to room (including sender, for confirmation)
            emit("message",
                {
                    "sender_id": sender_id,
                    "receiver_id": receiver_id,
                    "msg": message,
                    "timestamp": msg.timestamp.isoformat() if msg.timestamp else None
                },
                room=room
            )

        except IntegrityError:
            db.session.rollback()
            print("Error: Message sender or receiver does not exist.")
            emit("error", {"msg": "Invalid user ID"}, room=room)
        except Exception as db_e:
            db.session.rollback()
            print(f"DB Error: {db_e}")

    except Exception as e:
        print(f"Error in handle_send_message: {e}")


@socketio.on("leave")
def handle_leave(data):
    try:
        sender_id = data.get("sender_id")
        receiver_id = data.get("receiver_id")
        
        if not sender_id or not receiver_id:
            return

        room = get_room_id(sender_id, receiver_id)
        leave_room(room)

    except Exception as e:
        print(f"Error in handle_leave: {e}")


# =====================================================
# CHAT HISTORY API
# =====================================================
@chat.route("/history/<other_user_id>", methods=["GET"])
@token_required
def get_chat_history(other_user_id):
    try:
        # Get Auth Token from header (validated by @token_required)
        auth_header = request.headers.get("Authorization")
        token = auth_header.split(" ")[1]
        user_id = decode_token(token)

        # OPTIMIZATION: Use a single query with OR condition
        # Fetching 'other_user' existence check is skipped to save 1 query 
        # (empty list returned if user doesn't exist or no chat)
        
        messages = (
            db.session.query(ChatMessage)
            .filter(
                or_(
                    and_(ChatMessage.sender_id == user_id, ChatMessage.receiver_id == other_user_id),
                    and_(ChatMessage.sender_id == other_user_id, ChatMessage.receiver_id == user_id)
                )
            )
            .order_by(ChatMessage.timestamp.asc())
            .all()
        )

        messages_list = [
            {
                "sender_id": msg.sender_id,
                "receiver_id": msg.receiver_id,
                "msg": msg.message,
                "timestamp": msg.timestamp.isoformat() if msg.timestamp else ""
            }
            for msg in messages
        ]

        return jsonify(messages_list), 200

    except Exception as e:
        print(f"History Error: {e}")
        return jsonify({"error": str(e)}), 500
