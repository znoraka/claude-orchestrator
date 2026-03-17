import React from "react";
import ReactDOM from "react-dom/client";
import { SessionProvider } from "./contexts/SessionContext";
import { ToastProvider } from "./components/Toast";
import App from "./App";
import "./index.css";

// Add dark class to html element for CSS variable system
document.documentElement.classList.add("dark");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </ToastProvider>
  </React.StrictMode>,
);
