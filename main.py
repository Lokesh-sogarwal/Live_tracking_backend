from website import create_app
from website.extension import socketio
from flask_cors import CORS
import os

# Schedulers
from website.BusSchedular import init_scheduler
from website.UpdateLocaionSchedular import init_location_scheduler

app = create_app()

# Correct CORS setup
CORS(app, supports_credentials=True, origins=["http://localhost:3000"])

def run_schedulers_once():
    """Ensures schedulers run only in the main process (not reloader)."""
    # When debug=True, Flask runs two processes:
    # - Main process
    # - Reload process (WERKZEUG_RUN_MAIN == 'true')
    if app.debug:
        if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
            print("🔄 Running schedulers in DEBUG main process...")
            init_scheduler(app)
            init_location_scheduler(app)
        else:
            print("⏳ Skipping scheduler in DEBUG reloader process...")
    else:
        print("🚀 Running schedulers in PRODUCTION mode...")
        init_scheduler(app)
        init_location_scheduler(app)

if __name__ == "__main__":
    run_schedulers_once()

    # SocketIO server (REQUIRED for real-time features)
    socketio.run(
        app,
        host="0.0.0.0",
        port=5000,
        debug=app.debug,
        allow_unsafe_werkzeug=True  # needed for local dev
    )
