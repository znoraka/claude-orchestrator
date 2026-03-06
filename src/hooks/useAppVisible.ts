import { useState, useEffect } from "react";

/** Returns `true` when the app window/tab is visible and focused. */
export function useAppVisible(): boolean {
  const [visible, setVisible] = useState(!document.hidden);

  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return visible;
}
