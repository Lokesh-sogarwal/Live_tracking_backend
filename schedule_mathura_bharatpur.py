from datetime import datetime

from website import create_app
from website.database_utils import db
from website.model import Route, Bus, User, UserRole, Role
from website.BusSchedular import create_route_schedule


app = create_app()

with app.app_context():
    today = datetime.now()
    schedule_date_str = today.strftime("%Y-%m-%d")

    print("🔍 Looking for route Parichowk → Saket Metro...")
    route = (
        Route.query
        .filter(Route.start_point.ilike('%K.R. Puram%'))
        .filter(Route.end_point.ilike('%Yelahanka%'))
        .first()
    )

    if not route:
        print("❌ No route found with start like '" \
        "Parichowk' and end like 'Saket Metro'.")
    else:
        print(f"✅ Found route: {route.route_name} ({route.start_point} → {route.end_point})")

        # Pick first available bus
        bus = Bus.query.filter_by(bus_id=25).first()
        if not bus:
            print("❌ No buses found in database.")
        else:
            print(f"🚌 Using bus: {bus.bus_number} (id={bus.bus_id})")

            # Pick first available driver
            driver = (
                User.query
                .join(UserRole, User.id == UserRole.user_id)
                .join(Role, Role.role_id == UserRole.role_id)
                .filter(Role.role_name == 'driver', User.id == 25)
                .first()
            )

            if not driver:
                print("❌ No driver with role 'driver' found.")
            else:
                print(f"👤 Using driver: {driver.fullname} (id={driver.id})")

                # Set start time to today at 00:12 (12:12 AM)
                start_time = today.replace(hour=1, minute=8, second=0, microsecond=0)
                print(f"⏰ Scheduling trip at: {start_time}")

                end_time = create_route_schedule(route, bus, driver, start_time, schedule_date_str)
                if end_time:
                    print(f"🎉 Schedule created. ETA (end_time) = {end_time}")
                else:
                    print("⚠️ Schedule creation failed (see logs above).")
