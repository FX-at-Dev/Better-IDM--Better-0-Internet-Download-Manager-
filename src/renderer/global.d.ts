import type { PrismApi } from "../shared/types";

declare global {
  interface Window {
    prism: PrismApi;
  }
}
export {};
