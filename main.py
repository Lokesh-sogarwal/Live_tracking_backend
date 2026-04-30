import eventlet
eventlet.monkey_patch()

from website import create_app
from website.extension import socketio
from flask_cors import CORS
import os

# Schedulers
from website.BusSchedular import init_scheduler
from website.UpdateLocaionSchedular import init_location_scheduler

app = create_app()
CORS(app, supports_credentials=True, origins=["http://localhost:3000"])

if __name__ == "__main__":
    # Run schedulers ONLY ONCE (only when DB is available)
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not app.debug:
        if app.config.get('DB_CONNECTED'):
            init_scheduler(app)
            init_location_scheduler(app)
        else:
            print("⚠️ Skipping schedulers because DB is not connected.")

    # Run via SocketIO (NOT app.run)
    port = int(os.getenv("PORT", 5002))
    try:
        print(f"Starting SocketIO on 0.0.0.0:{port}")
        socketio.run(
            app,
            host="0.0.0.0",
            port=port,
            allow_unsafe_werkzeug=True,
        )
    except OSError as e:
        print("❌ Failed to bind socket:", e)
        raise