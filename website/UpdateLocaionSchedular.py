from flask import Blueprint, current_app, jsonify
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler
import requests
from website.model import Schedule, BusLocation
from website.database_utils import db

bus_sim = Blueprint("bus_sim", __name__)
scheduler = BackgroundScheduler()
scheduler.start()

ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImU2YTdlOGMyODhmYjQwMDRhYzNlNjRhYWJmODJmN2UyIiwiaCI6Im11cm11cjY0In0="

# Cache routes to avoid repeated ORS calls
precomputed_routes = {}

# -----------------------------
# Fetch route coordinates once
# -----------------------------
def get_route_coordinates(schedule):
    if schedule.schedule_id in precomputed_routes:
        return precomputed_routes[schedule.schedule_id]

    route = schedule.route
    start = [route.start_lng, route.start_lat]
    end = [route.end_lng, route.end_lat]

    if start == end:
        coords = [start, end]
    else:
        try:
            response = requests.post(
                "https://api.openrouteservice.org/v2/directions/driving-car/geojson",
                headers={"Authorization": ORS_API_KEY, "Content-Type": "application/json"},
                json={"coordinates": [start, end]},
                timeout=10
            )
            data = response.json()

            if "features" not in data or not data["features"]:
                print(f"⚠️ ORS returned no features for Bus {schedule.bus_id}, using start/end points")
                coords = [start, end]
            else:
                coords = [[lat, lon] for lon, lat in data["features"][0]["geometry"]["coordinates"]]

        except requests.exceptions.RequestException as e:
            print(f"Network error fetching route for Bus {schedule.bus_id}: {e}")
            coords = [start, end]
        except Exception as e:
            print(f"Error fetching route for Bus {schedule.bus_id}: {e}")
            coords = [start, end]

    precomputed_routes[schedule.schedule_id] = coords
    return coords

# -----------------------------
# Move bus along precomputed route
# -----------------------------
def move_bus(schedule_id, app):
    with app.app_context():
        schedule = Schedule.query.get(schedule_id)
        if not schedule:
            print(f"No schedule found for {schedule_id}")
            return

        if schedule.is_reached:
            return

        coords = get_route_coordinates(schedule)
        bus_id = schedule.bus_id

        idx = schedule.current_index or 0

        # mark running when first step executed
        if idx == 0 and schedule.status not in ("running", "arrived"):
            schedule.status = "running"
            db.session.commit()

        if idx >= len(coords):
            schedule.is_reached = True
            db.session.commit()
            print(f"✅ Bus {bus_id} reached destination.")
            return

        lat, lon = coords[idx]

        loc = BusLocation.query.filter_by(bus_id=bus_id).first()
        if loc:
            loc.latitude = lat
            loc.longitude = lon
        else:
            loc = BusLocation(bus_id=bus_id, latitude=lat, longitude=lon)
            db.session.add(loc)

        schedule.current_index = idx + 1
        if schedule.current_index >= len(coords):
            schedule.is_reached = True

        db.session.commit()
        # print(f"[{datetime.now().strftime('%H:%M:%S')}] Bus {bus_id} moved to {lat},{lon} (Index {schedule.current_index})")

# -----------------------------
# Schedule all today's buses
# -----------------------------
def schedule_todays_buses(app):
    with app.app_context():
        today_str = datetime.now().strftime("%Y-%m-%d")
        schedules = Schedule.query.filter_by(date=today_str).all()

        for sched in schedules:
            sched.current_index = 0
            sched.is_reached = False
            db.session.commit()

            # Ensure BusLocation exists at start
            loc = BusLocation.query.filter_by(bus_id=sched.bus_id).first()
            if not loc:
                start_lat = sched.route.start_lat
                start_lng = sched.route.start_lng
                loc = BusLocation(bus_id=sched.bus_id, latitude=start_lat, longitude=start_lng)
                db.session.add(loc)
                db.session.commit()

            job_id = f"bus_{sched.schedule_id}"
            if scheduler.get_job(job_id):
                continue  # Already scheduled

            # ✅ Pick start time: prefer arrival_time, else departure_time
            start_time = sched.arrival_time or sched.departure_time
            if isinstance(start_time, str):
                start_time = datetime.strptime(f"{today_str} {start_time}", "%Y-%m-%d %H:%M:%S")

            scheduler.add_job(
                move_bus,
                'interval',
                seconds=2,
                args=[sched.schedule_id, app],
                id=job_id,
                next_run_time=start_time
            )
            print(f"🚌 Scheduled bus {sched.bus_id} (schedule {sched.schedule_id}) at {start_time}")


# -----------------------------
# API to get bus location
# -----------------------------
@bus_sim.route("/get_location/<int:bus_id>")
def get_bus_location(bus_id):
    loc = BusLocation.query.filter_by(bus_id=bus_id).first()
    schedule = Schedule.query.filter_by(bus_id=bus_id, date=datetime.now().strftime("%Y-%m-%d")).first()

    if not loc or not schedule:
        return jsonify({"message": "Bus not started yet"}), 404

    return jsonify({
        "latitude": loc.latitude,
        "longitude": loc.longitude,
        "is_reached": schedule.is_reached
    })

# -----------------------------
# Initialize scheduler
# -----------------------------
def init_location_scheduler(app):
    schedule_todays_buses(app)
