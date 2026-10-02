"use client";
import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as "light" | "dark") || "light");
  }, []);
  function flip() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("jev-theme", next); } catch { /* ignore */ }
    setTheme(next);
  }
  return (
    <button type="button" onClick={flip} aria-pressed={theme === "dark"}
      className="rounded border border-line px-3 py-1 text-sm hover:bg-sel">
      {theme === "dark" ? "Dark theme" : "Light theme"}
    </button>
  );
}
