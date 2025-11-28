from flask import Blueprint, request, jsonify
from transformers import pipeline
import torch
import jwt
from datetime import date
import re

# Database models
from website.model import (
    User, Bus, BusLocation, Schedule, Stop
)

bot = Blueprint('chatbot', __name__)

# SAME SECRET KEY USED IN LOGIN
SECRET_KEY = "--Hackathon@inovatrix@-@2580#1234--"

print("Loading Llama 3.2 1B...")

chat_pipe = pipeline(
    "text-generation",
    model="meta-llama/Llama-3.2-1B-Instruct",
    device_map="cuda",
    dtype=torch.float16,
    max_new_tokens=200,
    temperature=0.7,
    repetition_penalty=1.1
)

print("Llama 3.2 1B Loaded on GPU!")


# ----------------------------------------------------
# JWT TOKEN DECODE → Fetch User From DB
# ----------------------------------------------------
def get_user_from_token(req):
    try:
        auth_header = req.headers.get("Authorization")

        if not auth_header or not auth_header.startswith("Bearer "):
            return None

        token = auth_header.split(" ")[1]

        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])

        user_id = payload.get("user_id")
        if not user_id:
            return None

        return User.query.filter_by(user_id=user_id).first()

    except Exception as e:
        print("JWT decode error:", e)
        return None


# ----------------------------------------------------
# HELPER: Extract bus number from free text
# supports things like: "bus number KA-01-AB-1234"
# or "schedules of bus KA-01-AB-1234 ?"
# ----------------------------------------------------
def extract_bus_number(raw_message: str) -> str | None:
    # 1. Try to find explicit "bus number XYZ"
    match = re.search(r"bus number\s+([A-Za-z0-9\-]+)", raw_message, re.IGNORECASE)
    if match:
        return match.group(1).strip().upper()

    # 2. Otherwise, pick any token that looks like a plate / has digits
    tokens = re.split(r"\s+", raw_message)
    candidates = []
    for t in tokens:
        cleaned = re.sub(r"[^\w\-]", "", t)  # remove punctuation, keep letters/digits/-
        if any(ch.isdigit() for ch in cleaned) and len(cleaned) >= 3:
            candidates.append(cleaned.upper())

    # Prefer the last candidate (often the bus number at end)
    if candidates:
        return candidates[-1]

    return None


# ----------------------------------------------------
# GET BUS LOCATION
# ----------------------------------------------------
def get_bus_location(bus_number: str):
    bus = Bus.query.filter_by(bus_number=bus_number).first()
    if not bus:
        return None, "Bus not registered in the system."

    loc = BusLocation.query.filter_by(bus_id=bus.bus_id).first()
    if not loc:
        return None, "Location for this bus is currently unavailable."

    return {
        "latitude": loc.latitude,
        "longitude": loc.longitude
    }, None


# ----------------------------------------------------
# GET TODAY'S BUS SCHEDULE
# ----------------------------------------------------
def get_bus_schedule(bus_number: str):
    bus = Bus.query.filter_by(bus_number=bus_number).first()
    if not bus:
        return None, "Bus not found in database."

    today = str(date.today())

    schedules = Schedule.query.filter_by(
        bus_id=bus.bus_id,
        date=today
    ).order_by(Schedule.arrival_time.asc()).all()

    if not schedules:
        return None, "No schedule found for this bus today."

    schedule_list = []

    for sch in schedules:
        stop = Stop.query.filter_by(stop_id=sch.stop_id).first()

        schedule_list.append({
            "stop": stop.name if stop else "Unknown stop",
            "arrival": sch.arrival_time.strftime("%H:%M"),
            "departure": sch.departure_time.strftime("%H:%M")
        })

    return schedule_list, None


# ----------------------------------------------------
# MAIN CHAT ROUTE
# ----------------------------------------------------
@bot.route("/chat", methods=["POST"])
def chat():
    data = request.get_json()
    raw_message = data.get("message", "").strip()
    message = raw_message.lower()

    # Authenticate User
    user_data = get_user_from_token(request)
    if not user_data:
        return jsonify({"reply": "Unauthorized or invalid token."}), 401

    # =====================================================
    # 1. BUS LOCATION INTENT
    # e.g. "where is bus KA-01-AB-1234"
    # =====================================================
    if (("where is" in message) or ("location" in message)) and "bus" in message:
        bus_number = extract_bus_number(raw_message)
        if not bus_number:
            return jsonify({"reply": "Please provide a valid bus number."})

        location, err = get_bus_location(bus_number)
        if err:
            return jsonify({"reply": err})

        return jsonify({
            "reply":
                f"📍 Current location of Bus {bus_number}:\n"
                f"Latitude: {location['latitude']}\n"
                f"Longitude: {location['longitude']}"
        })

    # =====================================================
    # 2. BUS SCHEDULE INTENT
    # Handles: "schedules of bus number KA-01-AB-1234 ?"
    #          "bus schedule for KA-01-AB-1234"
    #          "schedule for bus KA-01-AB-1234"
    # =====================================================
    if "schedule" in message and "bus" in message:
        bus_number = extract_bus_number(raw_message)
        if not bus_number:
            return jsonify({"reply": "Please specify the bus number."})

        schedule, err = get_bus_schedule(bus_number)
        if err:
            return jsonify({"reply": err})

        reply = f"🚌 Today's schedule for Bus {bus_number}:\n\n"
        for s in schedule:
            reply += f"• Stop: {s['stop']}\n  Arrival: {s['arrival']} | Departure: {s['departure']}\n\n"

        return jsonify({"reply": reply})

    # =====================================================
    # 3. NORMAL AI CHAT (LLAMA 3.2 1B) – fallback
    # =====================================================

    db_info = f"User: {user_data.fullname}, Email: {user_data.email}"

    prompt = f"""
<|system|>
You are a smart transport assistant. 
If the user asks about bus schedules or locations, you should answer using the bus database.
If the information is not available in the database, say so clearly instead of making things up.
Otherwise, chat with the user normally.

Database Info:
{db_info}

<|user|>
{raw_message}

<|assistant|>
"""

    raw = chat_pipe(prompt)[0]["generated_text"]
    bot_reply = raw.split("<|assistant|>")[-1].strip()

    return jsonify({"reply": bot_reply})
