from website import create_app
from flask_cors import CORS
import os
from website.BusSchedular import init_scheduler
from website.UpdateLocaionSchedular import init_location_scheduler

app = create_app()
CORS(app, supports_credentials=True, origins=["http://localhost:3000"])

if __name__ == '__main__':

    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not app.debug:
        init_scheduler(app)
        init_location_scheduler(app)

    app.run()
