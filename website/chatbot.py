<<<<<<< HEAD
from flask import Blueprint, request, jsonify, current_app
import os, re
import jwt
from datetime import date
from website.model import User, Bus, BusLocation, Schedule, Stop

bot = Blueprint('chatbot', __name__)

# ----------------------------------------------------
# ✅ SAFE BOT INITIALIZATION (skips AI model in deployment)
# ----------------------------------------------------
TRANSFORMERS_AVAILABLE = False
chat_pipe = None

try:
    import torch
    from transformers import pipeline

    # Only load the model when TRANSFORMERS is available
    TRANSFORMERS_AVAILABLE = True

    print("Loading Llama 3.2 1B...")
    chat_pipe = pipeline(
        "text-generation",
        model="meta-llama/Llama-3.2-1B-Instruct",
        device_map="auto",        # ✅ works without GPU requirement
        dtype=torch.float32,      # ✅ CPU-compatible
        max_new_tokens=120,       # ✅ reduced size/footprint
        temperature=0.6,
        repetition_penalty=1.1
    )
    print("Llama Model Loaded on CPU!")

except ModuleNotFoundError:
    print("⚠ Transformers/Torch not installed — Bot AI will be skipped in deployment.")
    TRANSFORMERS_AVAILABLE = False
    chat_pipe = None


# ----------------------------------------------------
# JWT TOKEN DECODE → Fetch User From DB
# ----------------------------------------------------
def get_user_from_token(req):
    try:
        from flask import current_app
        auth_header = req.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            return None

        token = auth_header.split(" ")[1]
        payload = jwt.decode(token, current_app.config['SECRET_KEY'], algorithms=["HS256"])
        user_id = payload.get("user_id")
        if not user_id:
            return None

        return User.query.filter_by(user_id=user_id).first()

    except Exception as e:
        print("JWT decode error:", e)
        return None


# ----------------------------------------------------
# HELPER: Extract bus number from free text
# ----------------------------------------------------
def extract_bus_number(raw_message: str):
    match = re.search(r"bus number\s+([A-Za-z0-9\-]+)", raw_message, re.IGNORECASE)
    if match:
        return match.group(1).strip().upper()

    tokens = re.split(r"\s+", raw_message)
    candidates = []
    for t in tokens:
        cleaned = re.sub(r"[^\w\-]", "", t)
        if any(ch.isdigit() for ch in cleaned) and len(cleaned) >= 3:
            candidates.append(cleaned.upper())

    if candidates:
        return candidates[-1]

    return None


# ----------------------------------------------------
# VALID ROUTE: Bot/AI status check
# ----------------------------------------------------
@bot.route("/chatbot-status")
def bot_status():
    if not TRANSFORMERS_AVAILABLE:
        return jsonify({"bot": "skipped", "status": "AI libraries not installed in container"})
    return jsonify({"bot": "active", "status": "AI loaded"})


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

    return {"latitude": loc.latitude, "longitude": loc.longitude}, None


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

    # Authenticate user
    user_data = get_user_from_token(request)
    if not user_data:
        return jsonify({"reply": "Unauthorized or invalid token."}), 401

    # 1. Bus location intent
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

    # 2. Bus schedule intent
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

    # 3. AI Chat fallback only if installed and model loaded
    if TRANSFORMERS_AVAILABLE and chat_pipe:
        prompt = f"""
<|system|>
You are a smart transport assistant.
<|user|>
{raw_message}
<|assistant|>
"""
        try:
            raw = chat_pipe(prompt)[0]["generated_text"]
            bot_reply = raw.split("<|assistant|>")[-1].strip()
            return jsonify({"reply": bot_reply})
        except Exception as e:
            print("AI pipeline failed:", e)
            return jsonify({"reply": "AI model error, but backend is running ✅"})

    # 4. Default text if AI is skipped
    return jsonify({"reply": "✅ Backend deployed on Railway. Chatbot AI was skipped to reduce build size."})
=======
"""
Chatbot removed — placeholder module.

This project no longer includes the chatbot feature. The original
`website/chatbot.py` logic (LLM + endpoints) was removed to simplify
the deployment and eliminate the `transformers`/`torch` runtime
dependencies.

No blueprint is exposed by this module anymore.
"""
>>>>>>> dc5dc98 (Make it render ready)
