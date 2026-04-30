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


# Simple health check for readiness probes
@app.route("/healthz", methods=["GET"])
def healthz():
    return {"status": "ok"}, 200

if __name__ == "__main__":
    run_schedulers_once()

<<<<<<< HEAD
    socketio.run(
        app,
        host="0.0.0.0",      # 🔥 REQUIRED FOR PHONE ACCESS
        port=5001,
        debug=False,
        use_reloader=False,
        allow_unsafe_werkzeug=True
    )
    
=======
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
>>>>>>> dc5dc98 (Make it render ready)
