import type { DesktopApi } from "./contract";

declare global {
  interface Window {
    orreryDesktop?: DesktopApi;
  }
}

export {};
