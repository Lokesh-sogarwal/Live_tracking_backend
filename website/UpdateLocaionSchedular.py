from flask import Blueprint, current_app, jsonify
from datetime import datetime, timedelta
from apscheduler.schedulers.background import BackgroundScheduler
import requests
import os
import time
from website.model import Schedule, BusLocation, Notification
from website.database_utils import db
from website.utils import notify_admins

bus_sim = Blueprint("bus_sim", __name__)
scheduler = BackgroundScheduler()

ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImU2YTdlOGMyODhmYjQwMDRhYzNlNjRhYWJmODJmN2UyIiwiaCI6Im11cm11cjY0In0="

# Cache routes to avoid repeated ORS calls
precomputed_routes = {}

DEFAULT_ROUTE_DURATION_SECONDS = 30 * 60  # used only when schedule times are missing/unparseable
MAX_FALLBACK_STEPS = 10000


def _duration_seconds_for_schedule(schedule) -> int:
    date_str = getattr(schedule, "date", None)
    start_time = _parse_dt(
        getattr(schedule, "arrival_time", None) or getattr(schedule, "departure_time", None),
        date_str,
    )
    end_time = _parse_dt(getattr(schedule, "departure_time", None), date_str)

    if start_time and end_time and end_time > start_time:
        return int((end_time - start_time).total_seconds())
    return DEFAULT_ROUTE_DURATION_SECONDS


def _desired_steps(schedule, interval_seconds: int) -> int:
    duration_seconds = _duration_seconds_for_schedule(schedule)
    steps = max(2, int(duration_seconds / max(interval_seconds, 1)) + 1)
    return min(steps, MAX_FALLBACK_STEPS)


def _resample_polyline(points: list[list[float]], target_steps: int) -> list[list[float]]:
    """Resample a polyline (list of [lat,lng]) down to target_steps.

    Keeps first/last points. If points already <= target_steps, returns as-is.
    """
    if not points:
        return points
    if target_steps <= 2:
        return [points[0], points[-1]] if len(points) > 1 else [points[0]]
    if len(points) <= target_steps:
        return points

    last_index = len(points) - 1
    sampled: list[list[float]] = []
    for i in range(target_steps):
        idx = round(i * last_index / (target_steps - 1))
        sampled.append(points[idx])
    return sampled


def _parse_dt(value, date_str: str | None):
    if value is None:
        return None

    if isinstance(value, datetime):
        return value

    raw = str(value).strip()
    if not raw:
        return None

    # Time-only like HH:MM:SS
    if len(raw) < 10 and date_str:
        try:
            return datetime.strptime(f"{date_str} {raw}", "%Y-%m-%d %H:%M:%S")
        except Exception:
            return None

    # Full datetime like YYYY-MM-DD HH:MM:SS
    try:
        return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def _fallback_route_points(schedule, interval_seconds: int) -> list[list[float]]:
    route = schedule.route
    start_lat, start_lng = route.start_lat, route.start_lng
    end_lat, end_lng = route.end_lat, route.end_lng

    if start_lat == end_lat and start_lng == end_lng:
        return [[start_lat, start_lng]]

    steps = _desired_steps(schedule, interval_seconds)

    points: list[list[float]] = []
    for i in range(steps):
        t = i / (steps - 1)
        lat = start_lat + (end_lat - start_lat) * t
        lng = start_lng + (end_lng - start_lng) * t
        points.append([lat, lng])
    return points

# -----------------------------
# Fetch route coordinates once
# -----------------------------
def get_route_coordinates(schedule):
    if schedule.schedule_id in precomputed_routes:
        return precomputed_routes[schedule.schedule_id]

    route = schedule.route
    # Keep internal representation as [lat, lng]
    start_latlng = [route.start_lat, route.start_lng]
    end_latlng = [route.end_lat, route.end_lng]

    # ORS expects [lng, lat]
    start_lnglat = [route.start_lng, route.start_lat]
    end_lnglat = [route.end_lng, route.end_lat]

    interval_seconds = 4  # must match scheduler interval
    target_steps = _desired_steps(schedule, interval_seconds)

    def cache_and_return(coords):
        precomputed_routes[schedule.schedule_id] = coords
        return coords

    if start_latlng == end_latlng:
        return cache_and_return([start_latlng])
    else:
        try:
            ors_key = (
                current_app.config.get("ORS_API_KEY")
                if current_app else None
            ) or os.getenv("ORS_API_KEY") or ORS_API_KEY

            # IMPORTANT: move_bus runs every 4s. Keep this call fast so jobs don't overlap.
            # Use short connect/read timeouts and minimal retries; fall back quickly if ORS is unreachable.
            ors_timeout = (3, 6)  # (connect timeout, read timeout)

            last_err = None
            for attempt in range(1, 3):
                try:
                    response = requests.post(
                        "https://api.openrouteservice.org/v2/directions/driving-car/geojson",
                        headers={"Authorization": ors_key, "Content-Type": "application/json"},
                        json={"coordinates": [start_lnglat, end_lnglat]},
                        timeout=ors_timeout,
                    )
                    response.raise_for_status()
                    data = response.json()

                    features = data.get("features") or []
                    if not features:
                        print(
                            f"⚠️ ORS returned no route for Bus {schedule.bus_id}; "
                            f"using fallback straight-line route"
                        )
                        return cache_and_return(_fallback_route_points(schedule, interval_seconds))

                    line = features[0].get("geometry", {}).get("coordinates") or []
                    if not line:
                        print(
                            f"⚠️ ORS route geometry missing for Bus {schedule.bus_id}; "
                            f"using fallback straight-line route"
                        )
                        return cache_and_return(_fallback_route_points(schedule, interval_seconds))

                    coords = [[lat, lng] for lng, lat in line]
                    coords = _resample_polyline(coords, target_steps)
                    return cache_and_return(coords)

                except requests.exceptions.ConnectionError as e:
                    # Connection refused / no route to host -> retrying won't help much.
                    last_err = e
                    break
                except requests.exceptions.Timeout as e:
                    last_err = e
                    if attempt < 2:
                        time.sleep(0.2)
                        continue
                    break
                except requests.exceptions.HTTPError as e:
                    # Auth/quota errors should not be retried.
                    last_err = e
                    break
                except requests.exceptions.RequestException as e:
                    last_err = e
                    break

            print(
                f"Network error fetching route for Bus {schedule.bus_id}: {last_err} "
                f"→ using fallback straight-line route"
            )
            return cache_and_return(_fallback_route_points(schedule, interval_seconds))

        except Exception as e:
            print(f"Error fetching route for Bus {schedule.bus_id}: {e} → using fallback route")
            return cache_and_return(_fallback_route_points(schedule, interval_seconds))

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

        # 🔄 When movement starts, mark schedule as running
        if schedule.status != "running":
            schedule.status = "running"

        # ⏳ Check for ETA/Ending Time Expiry
        # NOTE: Some schedules store only one timestamp (departure_time). If it's used as both
        # start and end, forcing completion would happen immediately. In that case we apply a
        # default duration window.
        now = datetime.now()
        date_str = getattr(schedule, "date", None)
        start_time = _parse_dt(
            getattr(schedule, "arrival_time", None) or getattr(schedule, "departure_time", None),
            date_str,
        )
        end_time = _parse_dt(getattr(schedule, "departure_time", None), date_str)

        if start_time and end_time and end_time <= start_time:
            end_time = start_time + timedelta(seconds=DEFAULT_ROUTE_DURATION_SECONDS)
        elif start_time and not end_time:
            end_time = start_time + timedelta(seconds=DEFAULT_ROUTE_DURATION_SECONDS)
        elif not start_time and not end_time:
            # Last resort: give the trip a reasonable window from "now".
            end_time = now + timedelta(seconds=DEFAULT_ROUTE_DURATION_SECONDS)

        # Force completion if time exceeded
        if isinstance(end_time, datetime) and now >= end_time:
            print(f"⏱️ ETA Exceeded for Bus {schedule.bus_id}. Forcing completion.")
            
            # Snap to last coordinate
            coords = get_route_coordinates(schedule)
            if coords:
                lat, lon = coords[-1]
                loc = BusLocation.query.filter_by(bus_id=schedule.bus_id).first()
                if loc:
                    loc.latitude = lat
                    loc.longitude = lon
                else:
                    loc = BusLocation(bus_id=schedule.bus_id, latitude=lat, longitude=lon)
                    db.session.add(loc)
                schedule.current_index = len(coords)
            
            schedule.is_reached = True
            schedule.status = "completed"
            
            # 🔔 Notification (Force Complete)
            try:
                msg = f"Trip Forced Complete: Bus {schedule.bus_id} exceeded ETA."
                db.session.add(Notification(user_id=schedule.driver_id, message=msg, type="warning"))
                notify_admins(f"ALERT: Bus {schedule.bus_id} exceeded ETA and was force-completed.", type="warning")
            except Exception as e:
                print(f"Notif Error: {e}")

            db.session.commit()
            return

        coords = get_route_coordinates(schedule)
        bus_id = schedule.bus_id

        idx = schedule.current_index or 0

        if idx >= len(coords):
            schedule.is_reached = True
            schedule.status = "completed"
            
             # 🔔 Notification (Already Complete)
            try:
                msg = f"Trip Completed: Bus {schedule.bus_id} reached destination."
                db.session.add(Notification(user_id=schedule.driver_id, message=msg, type="success"))
            except Exception as e:
                 print(f"Notif Error: {e}")

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
            schedule.status = "completed"
            # 🔔 Notification (Just Reached)
            try:
                msg = f"Trip Completed: Bus {schedule.bus_id} reached destination."
                db.session.add(Notification(user_id=schedule.driver_id, message=msg, type="success"))
                notify_admins(f"Trip Completed: Bus {schedule.bus_id} reached destination.", type="success")
            except Exception as e:
                print(f"Notif Error: {e}")

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

            # ✅ Pick start time: arrival_time (Start of Trip)
            start_time = sched.arrival_time or sched.departure_time
            if isinstance(start_time, str):
                # If it's just a time string (HH:MM:SS), append correct date
                if len(start_time) < 10: 
                     start_time = datetime.strptime(f"{today_str} {start_time}", "%Y-%m-%d %H:%M:%S")
                else:
                     start_time = datetime.strptime(str(start_time), "%Y-%m-%d %H:%M:%S")

            scheduler.add_job(
                move_bus,
                'interval',
                seconds=4,
                args=[sched.schedule_id, app],
                id=job_id,
                next_run_time=start_time
            )
            print(
                f"🚌 Scheduled bus {sched.bus_id} (schedule {sched.schedule_id}) at {start_time} (Update every 4s)"
            )


# -----------------------------
# API to get bus location
# -----------------------------
@bus_sim.route("/get_location/<int:bus_id>")
def get_bus_location(bus_id):
    loc = BusLocation.query.filter_by(bus_id=bus_id).first()
    
    # 🔍 Find the most relevant schedule for this bus today
    # Prioritize: 1. Active (Not Reached) 2. Recently Reached
    today_str = datetime.now().strftime("%Y-%m-%d")
    
    active_schedule = (
        Schedule.query
        .filter_by(bus_id=bus_id, date=today_str, is_reached=False)
        .order_by(Schedule.departure_time.asc())
        .first()
    )

    if not active_schedule:
        # If no active schedule, get the last completed one to show status
        schedule = (
            Schedule.query
            .filter_by(bus_id=bus_id, date=today_str)
            .order_by(Schedule.departure_time.desc())
            .first()
        )
    else:
        schedule = active_schedule

    if not loc or not schedule:
        return jsonify({"message": "Bus not started yet"}), 404

    return jsonify({
        "latitude": loc.latitude,
        "longitude": loc.longitude,
        "is_reached": schedule.is_reached,
        "schedule_id": schedule.schedule_id,
        "route_start": schedule.route.start_point,
        "route_end": schedule.route.end_point
    })

# -----------------------------
# Initialize scheduler
# -----------------------------
def init_location_scheduler(app):
    if not scheduler.running:
        scheduler.start()
        print("✅ Bus Simulation Scheduler Started")
    
    schedule_todays_buses(app)
