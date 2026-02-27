from flask_apscheduler import APScheduler
from datetime import datetime, timedelta
from math import radians, sin, cos, asin, sqrt
from flask import current_app
from website.database_utils import db
from website.model import *
from website.utils import notify_admins
from sqlalchemy import and_

scheduler = APScheduler()

# 🔧 Config
REVERSE_GAP_HOURS = 4  # gap between forward and reverse trip


# ---------- Helper: check duplicate schedule ----------
def schedule_exists(route_id, bus_id, date_str, arrival_time, departure_time):
    """Check if schedule already exists for same bus/route/date/time ±1 min."""
    key_time = arrival_time or departure_time
    if not key_time:
        return False

    start_window = key_time - timedelta(minutes=1)
    end_window = key_time + timedelta(minutes=1)

    print(f"[DEBUG] Checking duplicate | route={route_id}, bus={bus_id}, date={date_str}, key_time={key_time.strftime('%H:%M:%S')}")

    existing = (
        Schedule.query.filter(
            Schedule.route_id == route_id,
            Schedule.bus_id == bus_id,
            Schedule.date == date_str,
            and_(Schedule.arrival_time >= start_window,
                 Schedule.arrival_time <= end_window)
        ).first()
    )

    if existing:
        print(f"[DEBUG] Duplicate ARRIVAL found → schedule_id={existing.schedule_id}")
        return True

    existing_dep = (
        Schedule.query.filter(
            Schedule.route_id == route_id,
            Schedule.bus_id == bus_id,
            Schedule.date == date_str,
            and_(Schedule.departure_time >= start_window,
                 Schedule.departure_time <= end_window)
        ).first()
    )

    if existing_dep:
        print(f"[DEBUG] Duplicate DEPARTURE found → schedule_id={existing_dep.schedule_id}")
        return True

    print("[DEBUG] No duplicates found.")
    return False


def _estimate_trip_duration_minutes(route, avg_speed_kmph: float = 30.0) -> int:
    """Estimate trip duration (minutes) using straight-line distance and average speed.

    This is used to compute END time for the schedule.
    """
    try:
        # Haversine formula between start and end
        R = 6371.0  # Earth radius in km

        lat1, lon1 = radians(route.start_lat), radians(route.start_lng)
        lat2, lon2 = radians(route.end_lat), radians(route.end_lng)

        dlat = lat2 - lat1
        dlon = lon2 - lon1

        a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
        c = 2 * asin(sqrt(a))
        distance_km = R * c

        if distance_km <= 0:
            # Fallback minimum distance
            distance_km = 5.0

        hours = distance_km / max(avg_speed_kmph, 1.0)
        minutes = int(hours * 60)

        # Ensure a sensible minimum duration (e.g., 10 minutes)
        return max(minutes, 10)
    except Exception as e:
        print("[WARN] Failed to estimate duration, using default 30 min:", e)
        return 30


# ---------- Route Schedule (arrival_time = start, departure_time = end) ----------
def create_route_schedule(route, bus, driver, start_time, schedule_date_str, reverse=False):
    try:
        # 🔹 arrival_time will store START time
        start_dt = start_time

        # 🔹 Compute END time based on distance & avg speed
        trip_minutes = _estimate_trip_duration_minutes(route)
        end_dt = start_dt + timedelta(minutes=trip_minutes)

        # For duplicate check we pass start and end
        if schedule_exists(route.route_id, bus.bus_id, schedule_date_str, start_dt, end_dt):
            print(f"⚠️ Duplicate schedule detected for {bus.bus_number} at {start_dt}.")
            return end_dt

        new_schedule = Schedule(
            route_id=route.route_id,
            bus_id=bus.bus_id,
            driver_id=driver.id,
            arrival_time=start_dt,      # 👈 START TIME
            departure_time=end_dt,      # 👈 END TIME (ETA)
            status="yet to start",
            current_index=0 if not reverse else 1,
            date=schedule_date_str,
            is_reached=0 if not reverse else 0
        )

        db.session.add(new_schedule)
        db.session.commit()

        print(f"✅ Inserted schedule | Bus {bus.bus_number} | Route {route.route_name} | {'reverse' if reverse else 'forward'} | start={start_dt}, end={end_dt}")

        return end_dt

    except Exception as e:
        db.session.rollback()
        print("❌ DB error while inserting schedule:", e)
        return None


# ---------- Daily Schedule Generator ----------
def create_daily_schedules(days=1):
    try:
        with current_app.app_context():
            routes = Route.query.all()
            buses = Bus.query.all()
            drivers = (
                User.query
                .join(UserRole, User.id == UserRole.user_id)
                .join(Role, Role.role_id == UserRole.role_id)
                .filter(Role.role_name == "driver")
                .all()
            )

            print(f"[DEBUG] Loaded {len(routes)} routes, {len(buses)} buses, {len(drivers)} drivers.")

            if not routes or not buses or not drivers:
                print("⚠️ Missing data (routes/buses/drivers), skipping scheduler.")
                return

            assignments = list(zip(buses, drivers))

            for day_offset in range(days):
                schedule_date = datetime.now() + timedelta(days=day_offset)
                schedule_date_str = schedule_date.strftime("%Y-%m-%d")

                print(f"\n📅 Generating schedules for {schedule_date_str}")

                for i, route in enumerate(routes):
                    if i >= len(assignments):
                        print("⚠️ No more bus-driver pairs available.")
                        break
                    bus, driver = assignments[i]

                    # ✅ start at 7:00 AM and space every 30 minutes
                    start_time = schedule_date.replace(hour=7, minute=0, second=0, microsecond=0) + timedelta(minutes=i * 30)

                    driver_name = getattr(driver, 'fullname', getattr(driver, 'username', driver.email))
                    print(f"\n🚌 Creating FORWARD schedule | Bus {bus.bus_number} | Route {route.route_name} | Driver {driver_name}")

                    last_departure = create_route_schedule(
                        route, bus, driver, start_time, schedule_date_str
                    )

                    # Only schedule reverse if forward trip is reached
                    if last_departure:
                        last_schedule = (
                            Schedule.query.filter_by(
                                route_id=route.route_id,
                                bus_id=bus.bus_id,
                                date=schedule_date_str,
                                current_index=0
                            )
                            .order_by(Schedule.departure_time.desc())
                            .first()
                        )

                        if last_schedule:
                            print(f"[DEBUG] Last schedule found (id={last_schedule.schedule_id}, reached={last_schedule.is_reached})")

                        if last_schedule and last_schedule.is_reached == 1:
                            reverse_start = last_schedule.departure_time + timedelta(hours=REVERSE_GAP_HOURS)
                            print(f"↩️ Creating REVERSE schedule at {reverse_start.strftime('%H:%M')}")

                            if not schedule_exists(route.route_id, bus.bus_id, schedule_date_str, reverse_start, reverse_start + timedelta(minutes=2)):
                                create_route_schedule(route, bus, driver, reverse_start, schedule_date_str, reverse=True)
                            else:
                                print("⚠️ Duplicate reverse schedule detected, skipping.")
                        else:
                            print("⏩ Reverse trip skipped (bus not reached).")

            print(f"\n🎉 All schedules created for next {days} day(s).")
            
            # 🔔 Notify Admin
            notify_admins(f"Daily Schedules Generated for {schedule_date_str}", type="info")

    except Exception as e:
        db.session.rollback()
        print("❌ Scheduler error:", e)


# ---------- Initialize Scheduler ----------
def init_scheduler(app):
    app.config['SCHEDULER_API_ENABLED'] = True

    if not scheduler.get_job('daily_schedule_job'):
        scheduler.add_job(
            id='daily_schedule_job',
            func=lambda: schedule_with_context(app),
            trigger='cron',
            hour=14,
            minute=50
        )

    scheduler.init_app(app)
    scheduler.start()
    print("🚀 Scheduler started.")


def schedule_with_context(app):
    with app.app_context():
        print("[DEBUG] Running scheduled job...")
        create_daily_schedules(days=3)
