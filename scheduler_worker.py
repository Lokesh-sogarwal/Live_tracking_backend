"""Background scheduler runner.

Run this as a separate process (Render background worker) to start
APScheduler jobs in a single dedicated process. This avoids duplicate
jobs when running multiple Gunicorn workers for the web service.
"""
import time
import os
import sys
from website import create_app

# Import scheduler initializers
from website.BusSchedular import init_scheduler
from website.UpdateLocaionSchedular import init_location_scheduler


def main():
    app = create_app()

    # Only start schedulers if DB is connected
    if not app.config.get("DB_CONNECTED"):
        print("⚠ DB not connected — schedulers will not start. Check LOCAL_DATABASE_URL.")
        sys.exit(1)

    # Respect explicit env var to enable schedulers (default true for worker)
    start_flag = os.getenv("START_SCHEDULERS", "1").lower() in ("1", "true", "yes")
    if not start_flag:
        print("⚠ START_SCHEDULERS not enabled — exiting.")
        sys.exit(0)

    # Start schedulers
    try:
        print("Starting schedulers in worker...")
        init_scheduler(app)
        init_location_scheduler(app)
        print("Schedulers started — running loop.")
        # Keep the process alive
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        print("Scheduler worker interrupted — exiting.")
    except Exception as e:
        print("Scheduler worker failed:", e)
        raise


if __name__ == "__main__":
    main()
