import { afterEach, describe, expect, test } from "bun:test";
import { isTheme, nextTheme, readStoredTheme, resolveTheme, writeStoredTheme, THEME_CHANGE_EVENT, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "./theme";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let restoreTheme: (() => void) | undefined;
afterEach(() => {
  restoreTheme?.();
  restoreTheme = undefined;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function themeStorage(stored: string) {
  const values = new Map([[THEME_STORAGE_KEY, stored]]);
  let rejected = true;
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (rejected) throw new DOMException("Blocked", "QuotaExceededError");
          values.set(key, value);
        },
        removeItem: (key: string) => {
          if (rejected) throw new DOMException("Blocked", "SecurityError");
          values.delete(key);
        },
      },
      dispatchEvent: (event: Event) => target.dispatchEvent(event),
    },
  });
  restoreTheme = () => { rejected = false; writeStoredTheme("system"); };
  return { values, target, permit: () => { rejected = false; } };
}

describe("theme", () => {
  test("system follows the OS preference, explicit values win", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("cycle is light → dark → system → light", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
    expect(nextTheme("system")).toBe("light");
  });

  test("stored values are validated", () => {
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("sepia")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  test("pre-hydration script reads the same storage key", () => {
    expect(THEME_INIT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(THEME_INIT_SCRIPT).toContain('classList');
  });

  test("a rejected explicit preference reaches this tab's existing subscribers", () => {
    const storage = themeStorage("light");
    const observed: string[] = [];
    storage.target.addEventListener(THEME_CHANGE_EVENT, () => observed.push(readStoredTheme()));

    writeStoredTheme("dark");

    expect(observed).toEqual(["dark"]);
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("light");
  });

  test("a rejected system preference overrides stored dark and follows the OS", () => {
    themeStorage("dark");

    writeStoredTheme("system");

    expect(resolveTheme(readStoredTheme(), false)).toBe("light");
    expect(resolveTheme(readStoredTheme(), true)).toBe("dark");
  });

  test("the next successful write releases the tab-local override", () => {
    const storage = themeStorage("light");
    writeStoredTheme("dark");
    storage.permit();

    writeStoredTheme("light");
    storage.values.set(THEME_STORAGE_KEY, "dark");

    expect(readStoredTheme()).toBe("dark");
  });
});
