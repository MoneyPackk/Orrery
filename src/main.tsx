import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./components/app-shell";
import { reportDesktopSmokeReadiness } from "./desktop";
import { MissionProvider } from "./state/mission-context";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><MissionProvider><AppShell /></MissionProvider></StrictMode>,
);

void reportDesktopSmokeReadiness();
