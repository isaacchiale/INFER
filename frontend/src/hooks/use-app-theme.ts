import { useEffect, useState } from "react";

export type AppTheme = "light" | "dark";

export function readAppTheme(): AppTheme {
  if (typeof document === "undefined") return "light";
  if (document.documentElement.classList.contains("dark")) return "dark";
  try {
    const stored = localStorage.getItem("infer-theme");
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

/** Tracks the document `dark` class toggled by ThemeToggle. */
export function useAppTheme(): AppTheme {
  const [theme, setTheme] = useState<AppTheme>(() => readAppTheme());

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTheme(readAppTheme());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
