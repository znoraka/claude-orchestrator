import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { SessionProvider } from "./contexts/SessionContext";
import { ToastProvider } from "./components/Toast";
import { router } from "./router";
import "./index.css";

// Add dark class to html element for CSS variable system
document.documentElement.classList.add("dark");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </ToastProvider>
  </React.StrictMode>,
);
