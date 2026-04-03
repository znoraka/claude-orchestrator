import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

// Clockwise order of grid indices (0-8, center=4 excluded)
const CLOCKWISE = [0, 1, 2, 5, 8, 7, 6, 3];
const STEP_MS = 100;

interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  color?: string;
}

function Spinner({ className, color = "var(--accent-color)", ...props }: SpinnerProps) {
  // JS-driven tick to avoid WebKit throttling CSS step-end animations
  const [tick, setTick] = useState(0);
  const frameRef = useRef(0);

  useEffect(() => {
    let start: number | null = null;
    let raf: number;

    const step = (ts: number) => {
      if (start === null) start = ts;
      const next = Math.floor((ts - start) / STEP_MS);
      if (next !== frameRef.current) {
        frameRef.current = next;
        setTick(next);
      }
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      aria-label="Loading"
      role="status"
      className={cn("grid grid-cols-3 gap-px flex-shrink-0", className)}
      {...props}
    >
      {Array.from({ length: 9 }).map((_, i) => {
        if (i === 4) {
          return <div key={i} style={{ backgroundColor: color, opacity: 0.12 }} />;
        }
        const lightIndex = CLOCKWISE.indexOf(i);
        const phase = ((tick - lightIndex) % CLOCKWISE.length + CLOCKWISE.length) % CLOCKWISE.length;
        const opacity = phase === 0 ? 1 : phase === 1 ? 0.5 : phase === 2 ? 0.25 : 0.08;
        return <div key={i} style={{ backgroundColor: color, opacity }} />;
      })}
    </div>
  );
}

export { Spinner };
