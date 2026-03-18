import {
  createRootRoute,
  createRoute,
  createRouter,
  createHashHistory,
} from "@tanstack/react-router";
import App from "./App";

const rootRoute = createRootRoute({
  component: App,
});

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
});

export const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/session/$sessionId",
});

export const prsRoute = createRoute({
  getParentRoute: () => sessionRoute,
  path: "/prs",
});

export const shellRoute = createRoute({
  getParentRoute: () => sessionRoute,
  path: "/shell",
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  sessionRoute.addChildren([prsRoute, shellRoute]),
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultNotFoundComponent: () => null,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
