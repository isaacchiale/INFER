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
  // Always "light" on the first render, matching what the server rendered
  // (it has no DOM to read). __root.tsx's blocking inline script already
  // applied the real class to <html> before hydration, so reading it here
  // via a lazy initializer would make this component's first client render
  // diverge from the server's — the hydration mismatch previously visible
  // on GraphViewer's canvas (background/theme-dependent inline styles).
  // The real value is picked up a tick later in the effect below, after
  // hydration has already committed.
  const [theme, setTheme] = useState<AppTheme>("light");

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
