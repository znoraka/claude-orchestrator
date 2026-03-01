import React from "react";
import ReactDOM from "react-dom/client";
import { SessionProvider } from "./contexts/SessionContext";
import { ToastProvider } from "./components/Toast";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </ToastProvider>
  </React.StrictMode>,
);
