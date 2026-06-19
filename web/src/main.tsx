import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { GamesBrowser } from "./pages/GamesBrowser";
import { GameDetail } from "./pages/GameDetail";
import "@xyflow/react/dist/style.css";
import "./styles.css";

const router = createBrowserRouter([
  { path: "/", element: <GamesBrowser /> },
  { path: "/game/:id", element: <GameDetail /> },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
