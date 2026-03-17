import { createRootRoute, Outlet } from "@tanstack/react-router";
import { SessionProvider } from "../contexts/SessionContext";
import { ToastProvider } from "../components/Toast";

function RootRouteView() {
  return (
    <SessionProvider>
      <ToastProvider>
        <Outlet />
      </ToastProvider>
    </SessionProvider>
  );
}

export const Route = createRootRoute({
  component: RootRouteView,
});
