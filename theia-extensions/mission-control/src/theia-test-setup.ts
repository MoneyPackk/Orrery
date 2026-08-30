import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

if (!Object.getOwnPropertyDescriptor(globalThis, "localStorage")?.value) {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { value: {
    get length() { return values.size; }, clear: () => values.clear(), getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null, removeItem: (key: string) => values.delete(key), setItem: (key: string, value: string) => values.set(key, String(value)),
  } });
}

if (!("DragEvent" in globalThis)) {
  Object.defineProperty(globalThis, "DragEvent", { value: class DragEvent extends MouseEvent {} });
}

afterEach(cleanup);
