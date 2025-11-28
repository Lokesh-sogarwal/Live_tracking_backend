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
    # Run schedulers ONLY ONCE
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not app.debug:
        init_scheduler(app)
        init_location_scheduler(app)

    # Run via SocketIO (NOT app.run)
    socketio.run(
        app,
        host="0.0.0.0",
        port=5000,
        allow_unsafe_werkzeug=True
    )
