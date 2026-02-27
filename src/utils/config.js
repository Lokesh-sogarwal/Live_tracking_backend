// src/utils/config.js

// By default, React scripts sets NODE_ENV to 'development' in local dev, 
// and 'production' when building.
// But Vercel can also set custom env vars.

// Best practice: Set REACT_APP_API_BASE_URL in your .env file or Vercel dashboard.
// If not set, we fallback to localhost for development.

// If REACT_APP_API_BASE_URL isn't set, default to same-origin.
// This keeps local dev working via CRA's proxy (setupProxy.js) and also works when
// exposing the dev server through a tunnel like trycloudflare.
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || window.location.origin;

console.log("API Base URL:", API_BASE_URL);

export default API_BASE_URL;
