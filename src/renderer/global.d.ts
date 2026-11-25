import type { LanesApi } from "../shared/types";

declare global {
  interface Window {
    lanes: LanesApi;
  }
}
export {};
