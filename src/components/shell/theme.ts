/** Theme model shared by the server layout (inline script) and the client provider. */

export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "sb-theme";
/** In-tab change signal so every subscriber (useSyncExternalStore) re-reads storage. */
export const THEME_CHANGE_EVENT = "sb-theme-change";
const THEMES: readonly Theme[] = ["system", "light", "dark"];
// A rejected write still expresses this tab's choice; "system" is a choice too.
let unpersistedTheme: Theme | null = null;

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

/** light → dark → system → light. */
export function nextTheme(theme: Theme): Theme {
  return theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
}

/** Stored preference; anything unreadable or unknown counts as "system". */
export function readStoredTheme(): Theme {
  if (unpersistedTheme !== null) return unpersistedTheme;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function writeStoredTheme(theme: Theme): void {
  try {
    if (theme === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    unpersistedTheme = null;
  } catch {
    unpersistedTheme = theme;
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

/**
 * Runs before hydration (inline in <head>) so the first paint already carries
 * the right class. Dependency-free; mirrors ThemeProvider's applyTheme().
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);var c=document.documentElement.classList;if(d)c.add("dark");else c.remove("dark");}catch(e){}})();`;
