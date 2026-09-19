// Runtime settings for the browser app. Served as a plain static file, so it can change
// WITHOUT rebuilding anything (later: mount this file from a Kubernetes ConfigMap).
window.APP_CONFIG = {
  appName: "TaskBoard",
  apiBase: "/api",
  banner: "",            // e.g. "Maintenance tonight at 22:00" - shown at the top when not empty
  refreshSeconds: 5
};
