import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./ShowSchedules.css";
import API_BASE_URL from "../../../utils/config";

const ShowSchedules = () => {
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState("");

  const [expandedScheduleId, setExpandedScheduleId] = useState(null);


  const token = localStorage.getItem("token");
  const navigate = useNavigate();

  const getTodayLocalYYYYMMDD = () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };

  const inferStartEndFromRouteName = (routeName) => {
    const name = String(routeName || "").trim();
    if (!name) return { start: "—", end: "—" };
    const parts = name.split("-").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return { start: parts[0], end: parts.slice(1).join(" - ") };
    }
    return { start: name, end: "—" };
  };


  // Fetch schedules
  const fetchSchedules = async (filterDate = "") => {
    try {
      setLoading(true);
      let url = `${API_BASE_URL}/bus/schedules`;
      if (filterDate) {
        url += `?date=${filterDate}`;
      } else {
        url += `?`;
      }

      url += `${url.includes("?") && !url.endsWith("?") ? "&" : ""}include_route_details=1`;

      const res = await fetch(url, {
        headers: {
          Authorization: token ? `Bearer ${token}` : "",
        },
      });
      const data = await res.json();

      if (res.ok) {
        setSchedules(Array.isArray(data) ? data : []);
      } else {
        toast.error(data.error || "❌ Failed to fetch schedules");
      }
    } catch (err) {
      console.error("Error fetching schedules:", err);
      toast.error("🚨 Server error, try again later");
    } finally {
      setLoading(false);
    }
  };


  useEffect(() => {
    const today = getTodayLocalYYYYMMDD();
    setDateFilter(today);
    fetchSchedules(today);
  }, []);

  // Delhi realtime live-bus feed removed

  return (
    <div className="schedule-container">
      <div className="schedule-header">
        <div>
          <h1 className="schedule-title">📅 Bus Schedules</h1>
          <p className="schedule-subtitle">View and filter all upcoming and past bus schedules.</p>
        </div>
      </div>

      {/* Date Filter */}
      <div className="filter-section">
        <label>Filter by Date: </label>
        <input
          type="date"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
        />
        <button onClick={() => fetchSchedules(dateFilter)}>Apply</button>
        <button
          onClick={() => {
            const today = getTodayLocalYYYYMMDD();
            setDateFilter(today);
            fetchSchedules(today);
          }}
        >
          Today
        </button>
      </div>

      {/* Schedules Table */}
      {loading ? (
        <p className="schedule-loading">Loading schedules...</p>
      ) : schedules.length === 0 ? (
        <p className="schedule-empty">No schedules found for the selected date.</p>
      ) : (
        <div className="schedule-table-wrapper">
          <table className="schedule-table">
            <thead>
              <tr>
                <th>Route</th>
                <th>Start</th>
                <th>Destination</th>
                <th>Route Details</th>
                <th>Bus</th>
                <th>Driver</th>
                <th>Stop</th>
                <th>Arrival</th>
                <th>Departure</th>
                <th>Live Updated</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((sch) => {
                const inferred = inferStartEndFromRouteName(sch?.route_name);
                const startLabel = sch?.start_point || inferred.start;
                const endLabel = sch?.end_point || inferred.end;

                const normalizedStatus = String(sch.status || '')
                  .replace(/_/g, ' ')
                  .toLowerCase();

                const statusClass =
                  normalizedStatus === 'on time'
                    ? 'on_time'
                    : normalizedStatus === 'delayed'
                    ? 'delayed'
                    : normalizedStatus === 'cancelled'
                    ? 'cancelled'
                    : '';

                const statusLabel = normalizedStatus
                  ? normalizedStatus.replace(/\b\w/g, (l) => l.toUpperCase())
                  : 'On Time';

                const isExpanded = expandedScheduleId === sch.schedule_id;
                const routeStops = Array.isArray(sch?.route_stops) ? sch.route_stops : [];
                const stopsCount =
                  typeof sch?.route_stops_count === "number"
                    ? sch.route_stops_count
                    : routeStops.length;

                const arrival = sch?.arrival_time || sch?.end_time;
                const departure = sch?.departure_time || sch?.start_time;

                return (
                  <React.Fragment key={sch.schedule_id}>
                    <tr>
                      <td>{sch?.route_name || "—"}</td>
                      <td>{startLabel || "—"}</td>
                      <td>{endLabel || "—"}</td>
                      <td>
                        {stopsCount > 0 ? (
                          <button
                            onClick={() =>
                              setExpandedScheduleId(isExpanded ? null : sch.schedule_id)
                            }
                          >
                            {isExpanded ? "Hide Stops" : `View Stops (${stopsCount})`}
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{sch.bus_number}</td>
                      <td>{sch.driver_name}</td>
                      <td>{sch.stop_name}</td>
                      <td>{arrival || "—"}</td>
                      <td>{departure || "—"}</td>
                      <td>
                        —
                      </td>
                      <td>
                        <span className={`schedule-status ${statusClass}`}>{statusLabel}</span>
                      </td>
                      <td>{sch.date}</td>
                    </tr>

                    {isExpanded ? (
                      <tr>
                        <td colSpan={12}>
                          <div style={{ padding: "10px 6px" }}>
                            <div style={{ marginBottom: "6px" }}>
                              <b>From → To:</b> {(startLabel || "—")} → {(endLabel || "—")}
                            </div>
                            <b>Stops:</b>{" "}
                            {routeStops.length > 0
                              ? routeStops
                                  .slice()
                                  .sort((a, b) => (a?.sequence || 0) - (b?.sequence || 0))
                                  .map((s) => s?.stop_name)
                                  .filter(Boolean)
                                  .join(" → ")
                              : "No stops found for this route."}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ToastContainer position="top-right" autoClose={3000} />
    </div>
  );
};

export default ShowSchedules;
