import os
from functools import wraps
import random
import requests
from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from flask import Blueprint, request, jsonify, session, current_app
from werkzeug.utils import secure_filename
from datetime import datetime, timedelta

from website.database_utils import db
from website.model import Route, Schedule, Stop, Bus, User, UserRole, Role
from website.auth import token_required, decode_token
import jwt

bus = Blueprint('bus', __name__)

def geocode_place(place_name):
    """Convert place name to lat/lng using Nominatim API"""
    try:
        response = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": place_name, "format": "json", "limit": 1},
            headers={"User-Agent": "BusApp/1.0"}
        )
        data = response.json()
        if not data:
            return None, None
        return float(data[0]['lat']), float(data[0]['lon'])
    except Exception as e:
        print("Geocoding error:", e)
        return None, None

@bus.route('/bus_route', methods=['POST'])
@token_required
def bus_route():
    auth_header = request.headers.get('Authorization')
    if not auth_header:
        return jsonify({'error': 'Authorization header missing'}), 401

    data = request.get_json()
    route_name = data.get('route_name')
    start_point_name = data.get('starting')
    end_point_name = data.get('destination')
    stops = data.get('stops', [])  # ✅ optional stops array

    # Validate inputs
    if not route_name or not start_point_name or not end_point_name:
        return jsonify({'error': 'Kindly fill all the details'}), 400

    # Geocode start and end points
    start_lat, start_lng = geocode_place(start_point_name)
    end_lat, end_lng = geocode_place(end_point_name)

    if start_lat is None or end_lat is None:
        return jsonify({'error': 'Unable to geocode start or end point'}), 400

    try:
        # Save route
        new_route = Route(
            route_name=route_name,
            start_point=start_point_name,
            end_point=end_point_name,
            start_lat=start_lat,
            start_lng=start_lng,
            end_lat=end_lat,
            end_lng=end_lng
        )
        db.session.add(new_route)
        db.session.flush()  # ✅ ensures route_id is available

        # Save stops
        created_stops = []
        for idx, stop_name in enumerate(stops, start=1):
            lat, lng = geocode_place(stop_name)
            if lat and lng:
                stop = Stop(
                    route_id=new_route.route_id,
                    name=stop_name,
                    latitude=lat,
                    longitude=lng,
                    sequence=idx
                )
                db.session.add(stop)
                created_stops.append({
                    "stop_name": stop_name,
                    "latitude": lat,
                    "longitude": lng,
                    "sequence": idx
                })

        db.session.commit()

        return jsonify({
            'message': 'Bus route created successfully',
            'route': {
                'route_id': new_route.route_id,
                'route_name': new_route.route_name,
                'start_point': new_route.start_point,
                'end_point': new_route.end_point,
                'start_lat': new_route.start_lat,
                'start_lng': new_route.start_lng,
                'end_lat': new_route.end_lat,
                'end_lng': new_route.end_lng,
                'stops': created_stops
            }
        }), 201

    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@bus.route('/get_routes', methods=["POST"])
def get_routes():
    try:
        auth_header = request.headers.get('Authorization')
        if not auth_header:
            print("[DEBUG] Missing Authorization header")
            return jsonify({'error': 'Authorization header missing'}), 401

        data = request.get_json(force=True)
        starting = data.get('starting_point')
        dest = data.get('destination')

        print("\n[DEBUG] ---- New Request ----")
        print("[DEBUG] Raw Input JSON:", data)
        print("[DEBUG] Starting Point:", starting)
        print("[DEBUG] Destination:", dest)

        if not starting and not dest:
            return jsonify({"error": "Kindly provide starting and/or destination"}), 400

        # 🔍 Flexible partial + reverse search
        query = Route.query
        if starting and dest:
            query = query.filter(
                and_(
                    or_(
                        Route.start_point.ilike(f"%{starting}%"),
                        Route.end_point.ilike(f"%{starting}%")
                    ),
                    or_(
                        Route.end_point.ilike(f"%{dest}%"),
                        Route.start_point.ilike(f"%{dest}%")
                    )
                )
            )
        elif starting:
            query = query.filter(
                or_(
                    Route.start_point.ilike(f"%{starting}%"),
                    Route.end_point.ilike(f"%{starting}%")
                )
            )
        elif dest:
            query = query.filter(
                or_(
                    Route.end_point.ilike(f"%{dest}%"),
                    Route.start_point.ilike(f"%{dest}%")
                )
            )

        routes = query.all()
        print(f"[DEBUG] Total routes found: {len(routes)}")

        if not routes:
            return jsonify({"message": "No route found"}), 404

        final_response = []

        for route in routes:
            print(f"[DEBUG] Checking route: {route.route_name} (ID={route.route_id})")

            # ✅ Only schedules without stop_id
            schedules = (
                db.session.query(Schedule, Bus, User)
                .join(Bus, Schedule.bus_id == Bus.bus_id)
                .join(User, Schedule.driver_id == User.id)
                .filter(
                    Schedule.route_id == route.route_id,
                    Schedule.stop_id.is_(None)
                )
                .order_by(Schedule.arrival_time)
                .all()
            )

            if not schedules:
                print(f"[DEBUG] No schedules without stops for route {route.route_id}")
                continue

            schedule_list = []
            for sched, bus, driver in schedules:
                # ✅ Safe conversion for all time/date fields
                def safe_format(dt):
                    if dt is None:
                        return None
                    if isinstance(dt, str):
                        return dt  # already a string
                    try:
                        return dt.strftime("%Y-%m-%d %H:%M:%S")
                    except Exception:
                        return str(dt)

                schedule_data = {
                    "schedule_id": sched.schedule_id,
                    "bus_number": bus.bus_number,
                    "driver_name": driver.fullname,
                    "bus_id": bus.bus_id,
                    "arrival_time": safe_format(sched.arrival_time),
                    "departure_time": safe_format(sched.departure_time),
                    "status": sched.status,
                    "date": safe_format(sched.date),
                    "is_reached": sched.is_reached
                }
                schedule_list.append(schedule_data)

            final_response.append({
                "route_id": route.route_id,
                "route_name": route.route_name,
                "start_lat": route.start_lat,
                "start_lng": route.start_lng,
                "end_lat": route.end_lat,
                "end_lng": route.end_lng,
                "start_point": route.start_point,
                "end_point": route.end_point,
                "schedules": schedule_list
            })

        if not final_response:
            return jsonify({"message": "No routes found without stops"}), 404

        print(f"[DEBUG] Final response with {len(final_response)} routes ready")
        return jsonify(final_response), 200

    except Exception as e:
        print("[ERROR] get_routes Exception:", str(e))
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500






@bus.route("/geocode", methods=["GET"])
def geocode():
    address = request.args.get("address")
    if not address:
        return jsonify({"error": "Address required"}), 400

    try:
        # Check if input is coordinates
        if "," in address:
            try:
                lat, lon = address.split(",")
                lat = float(lat.strip())
                lon = float(lon.strip())
            except ValueError:
                return jsonify({"error": "Invalid coordinates"}), 400

            response = requests.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={"format": "json", "lat": lat, "lon": lon, "zoom": 18, "addressdetails": 1},
                headers={"User-Agent": "LiveTrackingApp/1.0"}
            )
            data = response.json()
            result = [{"lat": lat, "lon": lon, "display_name": data.get("display_name", "")}]
            return jsonify(result)

        else:
            response = requests.get(
                "https://nominatim.openstreetmap.org/search",
                params={"format": "json", "q": address, "limit": 1},
                headers={"User-Agent": "LiveTrackingApp/1.0"}
            )
            data = response.json()
            if not data:
                return jsonify({"error": "Location not found"}), 404
            return jsonify(data)

    except requests.exceptions.RequestException as e:
        return jsonify({"error": "Network error: " + str(e)}), 500
    except Exception as e:
        return jsonify({"error": "Server error: " + str(e)}), 500
@bus.route("/schedules", methods=["GET"])
def get_schedules():
    date_filter = request.args.get("date")
    print("🟢 Received request for schedules")
    print("➡️ Date filter received:", date_filter)

    # Base query with joins
    query = (
        db.session.query(Schedule, Bus, Route, Stop, User)
        .join(Bus, Schedule.bus_id == Bus.bus_id)
        .join(Route, Schedule.route_id == Route.route_id)
        .outerjoin(Stop, Schedule.stop_id == Stop.stop_id)  # <-- outer join (stop can be NULL)
        .join(User, Schedule.driver_id == User.id)
    )

    # Apply date filter if provided
    if date_filter:
        try:
            datetime.strptime(date_filter, "%Y-%m-%d")  # validate
            query = query.filter(Schedule.date == date_filter)
            print(f"✅ Filtering schedules by date: {date_filter}")
        except ValueError:
            print("❌ Invalid date format received:", date_filter)
            return jsonify({"error": "Invalid date format, use YYYY-MM-DD"}), 400

    schedules = query.all()
    print(f"🔍 Query returned {len(schedules)} rows")

    results = []
    for schedule, bus, route, stop, driver in schedules:
        result = {
            "schedule_id": schedule.schedule_id,
            "route_name": route.route_name,
            "bus_number": bus.bus_number,
            "driver_name": driver.fullname,
            "stop_name": stop.name if stop else "N/A",  # handle NULL stop
            "arrival_time": schedule.arrival_time.strftime("%H:%M") if schedule.arrival_time else None,
            "departure_time": schedule.departure_time.strftime("%H:%M") if schedule.departure_time else None,
            "status": schedule.status,
            "date": schedule.date,
            "is_reached":schedule.is_reached
        }
        print("📌 Row:", result)
        results.append(result)

    return jsonify(results)
