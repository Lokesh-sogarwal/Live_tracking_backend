import time
from datetime import datetime, timezone

import requests
from flask import Blueprint, current_app, jsonify, request

try:
    # Package name: gtfs-realtime-bindings
    from google.transit import gtfs_realtime_pb2  # type: ignore
except Exception:  # pragma: no cover
    gtfs_realtime_pb2 = None


realtime = Blueprint("realtime", __name__)


_cache = {
    "ts": 0.0,
    "data": None,
    "status": 0,
    "error": None,
}


def _utc_iso(ts: int | float | None) -> str | None:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
    except Exception:
        return None


def _fetch_vehicle_positions(*, api_key: str, url: str, timeout: int = 15) -> bytes:
    resp = requests.get(url, params={"key": api_key}, timeout=timeout)
    resp.raise_for_status()
    return resp.content


def _decode_vehicle_positions(pb_bytes: bytes) -> list[dict]:
    if gtfs_realtime_pb2 is None:
        raise RuntimeError(
            "GTFS-Realtime bindings not installed. Install 'gtfs-realtime-bindings' and 'protobuf'."
        )

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(pb_bytes)

    vehicles: list[dict] = []

    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue

        veh = entity.vehicle
        if not veh.HasField("position"):
            continue

        pos = veh.position

        # Vehicle descriptor
        vehicle_desc = veh.vehicle if veh.HasField("vehicle") else None

        vehicles.append(
            {
                "entity_id": entity.id or None,
                "vehicle_id": (vehicle_desc.id if vehicle_desc else None) or None,
                "label": (vehicle_desc.label if vehicle_desc else None) or None,
                "license_plate": (vehicle_desc.license_plate if vehicle_desc else None) or None,
                "trip_id": (veh.trip.trip_id if veh.HasField("trip") else None) or None,
                "route_id": (veh.trip.route_id if veh.HasField("trip") else None) or None,
                "direction_id": (veh.trip.direction_id if veh.HasField("trip") and veh.trip.HasField("direction_id") else None),
                "latitude": float(getattr(pos, "latitude", 0.0)),
                "longitude": float(getattr(pos, "longitude", 0.0)),
                "bearing": float(getattr(pos, "bearing", 0.0)) if pos.HasField("bearing") else None,
                "speed": float(getattr(pos, "speed", 0.0)) if pos.HasField("speed") else None,
                "timestamp": int(veh.timestamp) if veh.HasField("timestamp") else None,
                "timestamp_iso": _utc_iso(int(veh.timestamp)) if veh.HasField("timestamp") else None,
            }
        )

    return vehicles


@realtime.route("/delhi/vehicle_positions", methods=["GET"])
def delhi_vehicle_positions():
    """Proxy + decode Delhi GTFS-Realtime VehiclePositions.pb into JSON.

    Query params:
      - limit: int (optional)
      - route_id: filter by GTFS route_id (optional)

    Env vars (backend):
      - DELHI_REALTIME_API_KEY (required)
      - DELHI_REALTIME_URL (optional)
      - DELHI_REALTIME_CACHE_SECONDS (optional)
    """

    api_key = current_app.config.get("DELHI_REALTIME_API_KEY")
    url = current_app.config.get("DELHI_REALTIME_URL")
    cache_seconds = int(current_app.config.get("DELHI_REALTIME_CACHE_SECONDS") or 0)

    if not api_key:
        return (
            jsonify(
                {
                    "error": "Missing DELHI_REALTIME_API_KEY in backend environment.",
                    "hint": "Set DELHI_REALTIME_API_KEY and restart backend.",
                }
            ),
            400,
        )

    now = time.time()
    if cache_seconds > 0 and _cache["data"] is not None and (now - _cache["ts"]) < cache_seconds:
        payload = _cache["data"]
        status = _cache["status"] or 200
        return jsonify(payload), status

    try:
        pb = _fetch_vehicle_positions(api_key=api_key, url=url)
        vehicles = _decode_vehicle_positions(pb)

        route_id = (request.args.get("route_id") or "").strip()
        if route_id:
            vehicles = [v for v in vehicles if (v.get("route_id") or "") == route_id]

        limit_raw = (request.args.get("limit") or "").strip()
        if limit_raw:
            try:
                limit = max(1, min(int(limit_raw), 5000))
                vehicles = vehicles[:limit]
            except Exception:
                pass

        payload = {
            "source": "delhi-otd-gtfs-realtime",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "vehicle_count": len(vehicles),
            "vehicles": vehicles,
        }

        _cache.update({"ts": now, "data": payload, "status": 200, "error": None})
        return jsonify(payload), 200

    except requests.HTTPError as e:
        status = getattr(e.response, "status_code", 502) or 502
        payload = {
            "error": "Upstream GTFS-Realtime request failed",
            "status": status,
        }
        _cache.update({"ts": now, "data": payload, "status": status, "error": str(e)})
        return jsonify(payload), status

    except Exception as e:
        payload = {"error": "Failed to fetch/decode GTFS-Realtime feed", "details": str(e)}
        _cache.update({"ts": now, "data": payload, "status": 500, "error": str(e)})
        return jsonify(payload), 500
