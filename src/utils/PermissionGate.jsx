import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { jwtDecode } from "jwt-decode";
import { usePermissions } from "../context/PermissionsContext";
import { normalizeRole } from "./legacyAccess";

const PermissionGate = ({ permissionKey, requireSuperadmin = false, children }) => {
  const token = localStorage.getItem("token");
  const { isLoading, can } = usePermissions();
  const location = useLocation();

  let role = "";
  try {
    role = token ? jwtDecode(token).role : "";
  } catch (e) {
    role = "";
  }

  const normalizedRole = normalizeRole(role);

  if (requireSuperadmin) {
    if (!normalizedRole || normalizedRole !== "superadmin") {
      return <Navigate to="/dashboard" replace />;
    }
  }

  // While loading, avoid redirect flicker; show the page (or keep blank).
  if (isLoading) {
    return children;
  }

  if (permissionKey) {
    // Plan gating + explicit permission gating (superadmin bypass lives inside can())
    if (!can(permissionKey)) {
      // Avoid redirect loops if the user is blocked from dashboard.
      const currentPath = location?.pathname || "";
      const fallback = currentPath.startsWith("/dashboard") ? "/profile" : "/dashboard";
      return <Navigate to={fallback} replace />;
    }
  }

  return children;
};

export default PermissionGate;
