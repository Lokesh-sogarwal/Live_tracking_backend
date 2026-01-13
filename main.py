from website import create_app
from website.extension import socketio

# Schedulers
from website.BusSchedular import init_scheduler
from website.UpdateLocaionSchedular import init_location_scheduler

app = create_app()

def run_schedulers_once():
    print("🚀 Running schedulers...")
    init_scheduler(app)
    init_location_scheduler(app)

if __name__ == "__main__":
    run_schedulers_once()

    socketio.run(
        app,
        host="0.0.0.0",      # 🔥 REQUIRED FOR PHONE ACCESS
        port=5001,
        debug=False,
        use_reloader=False,
        allow_unsafe_werkzeug=True
    )
    
