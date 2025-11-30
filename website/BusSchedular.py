from flask_apscheduler import APScheduler
from datetime import datetime, timedelta
from flask import current_app
from website.database_utils import db
from website.model import *
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


# ---------- Route Schedule (auto stop_id fix) ----------
def create_route_schedule(route, bus, driver, start_time, schedule_date_str, reverse=False):
    try:
        # define trip times
        arrival_time = start_time + timedelta(minutes=30)  # assume 30 mins trip
        departure_time = arrival_time + timedelta(minutes=5)

        if schedule_exists(route.route_id, bus.bus_id, schedule_date_str, arrival_time, departure_time):
            print(f"⚠️ Duplicate schedule detected for {bus.bus_number} at {arrival_time}.")
            return departure_time

        new_schedule = Schedule(
            route_id=route.route_id,
            bus_id=bus.bus_id,
            driver_id=driver.id,
            arrival_time=arrival_time,
            departure_time=departure_time,
            status="on_time",
            current_index=0 if not reverse else 1,
            date=schedule_date_str,
            is_reached=0 if not reverse else 0
        )

        db.session.add(new_schedule)
        db.session.commit()

        print(f"✅ Inserted schedule | Bus {bus.bus_number} | Route {route.route_name} | {'reverse' if reverse else 'forward'} | {arrival_time}")

        return departure_time

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
            minute=54
        )

    scheduler.init_app(app)
    scheduler.start()
    print("🚀 Scheduler started.")


def schedule_with_context(app):
    with app.app_context():
        print("[DEBUG] Running scheduled job...")
        create_daily_schedules(days=1)
