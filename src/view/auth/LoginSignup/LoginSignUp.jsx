import React, { useState } from "react";
import "./LoginSignup.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFacebook, faGoogle, faTwitter } from "@fortawesome/free-brands-svg-icons";
import { useNavigate } from "react-router-dom";
import { toast, ToastContainer } from "react-toastify"; 
import API_BASE_URL from "../../../utils/config";

const Login = () => {
  const [formData, setFormData] = useState({
    email: "",
    password: "",
  });
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const GoogleLogin = () => {
    toast.info("Google login is disabled right now!");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
        credentials: "include",
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong");
        toast.error(data.error || "Something went wrong");
        return;
      }

      if (data.token) {
        localStorage.setItem("token", data.token);
        toast.success("Login Successful");

        navigate("/dashboard");
      }
    } catch (err) {
      setError("Server error. Please try again later.");
      toast.error("Server error. Please try again later.");
    }
  };

  const goToSignup = () => {
    navigate("/signup");
  };

  return (
    <div className="login-main">
      <div className="login-orbit login-orbit-1" />
      <div className="login-orbit login-orbit-2" />
      <div className="auth-shell">
        {/* LEFT: FORM PANEL */}
        <div className="auth-left-panel">
          <div className="auth-top-row">
            <button
              type="button"
              className="auth-back-pill"
              onClick={() => navigate("/")}
            >
              ←
            </button>
            <div className="auth-top-link">
              <span>New here?</span>
              <button type="button" onClick={goToSignup} className="auth-inline-link">
                Create an account
              </button>
            </div>
          </div>

          <h1 className="auth-title">Sign in</h1>
          <p className="auth-subtitle-text">
            Log in to monitor live buses, manage routes and keep every
            passenger informed in real time.
          </p>

          <form className="auth-form" onSubmit={handleSubmit}>
            <div className="auth-input-row">
              <span className="auth-input-label">Email</span>
              <input
                type="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                placeholder="Enter your email" 
                required
              />
            </div>
            <div className="auth-input-row">
              <span className="auth-input-label">Password</span>
              <input
                type="password"
                name="password"
                value={formData.password}
                onChange={handleChange}
                placeholder="Enter your password"
                required
              />
            </div>

            <div className="auth-extra-row">
              <a href="#" className="auth-inline-link">
                Forgot password?
              </a>
            </div>

            <button type="submit" className="auth-primary-btn">
              Login
            </button>

            <div className="auth-or-row">
              <span />
              <p>or continue with</p>
              <span />
            </div>

            <div className="social-signup">
              <button type="button" onClick={GoogleLogin}>
                <FontAwesomeIcon icon={faGoogle} size="lg" />
              </button>
              <button type="button">
                <FontAwesomeIcon icon={faFacebook} size="lg" />
              </button>
              <button type="button">
                <FontAwesomeIcon icon={faTwitter} size="lg" />
              </button>
            </div>

            <p className="auth-bottom-text">
              Don’t have an account?{" "}
              <button
                type="button"
                onClick={goToSignup}
                className="auth-inline-link"
              >
                Sign up
              </button>
            </p>
          </form>
        </div>

        {/* RIGHT: DEVICE ILLUSTRATION PANEL (DESKTOP + MOBILE) */}
        <div className="auth-right-panel">
          <div className="auth-right-gradient" />
          <div className="auth-right-content">
            <div className="auth-device-stack" aria-hidden="true">
              <div className="auth-device auth-device-main">
                <div className="auth-device-header">
                  <span className="auth-device-title">Live Fleet Dashboard</span>
                  <span className="auth-device-status">All routes online</span>
                </div>
                <div className="auth-device-map">
                  <span className="auth-device-line auth-device-line-1" />
                  <span className="auth-device-line auth-device-line-2" />
                  <span className="auth-device-line auth-device-line-3" />
                  <span className="auth-device-stop stop-1" />
                  <span className="auth-device-stop stop-2" />
                  <span className="auth-device-stop stop-3" />
                </div>
                <div className="auth-device-footer">
                  <div>
                    <p className="auth-device-label">Active buses</p>
                    <p className="auth-device-value">42</p>
                  </div>
                  <div>
                    <p className="auth-device-label">On-time</p>
                    <p className="auth-device-value success">96%</p>
                  </div>
                  <div>
                    <p className="auth-device-label">Alerts</p>
                    <p className="auth-device-value warning">3</p>
                  </div>
                </div>
              </div>

              <div className="auth-device auth-device-secondary">
                <div className="auth-device-secondary-header">
                  <span className="auth-device-badge">Passenger view</span>
                  <span className="auth-device-time">08:35</span>
                </div>
                <div className="auth-device-secondary-body">
                  <p className="auth-device-secondary-title">Next bus in 4 min</p>
                  <p className="auth-device-secondary-sub">
                    Route 12 · Campus Loop
                  </p>
                  <div className="auth-device-progress">
                    <span className="auth-device-progress-fill" />
                  </div>
                  <div className="auth-device-tags">
                    <span>Live ETA</span>
                    <span>Stop alerts</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <ToastContainer />
    </div>
  );
};

export default Login;
