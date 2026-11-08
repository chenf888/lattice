import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";

import "./styles/globals.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Lattice：缺少 #root 挂载点");
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
