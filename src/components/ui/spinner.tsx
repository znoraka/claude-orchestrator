import { cn } from "../../lib/cn";

// Clockwise order of grid indices (0-8, center=4 excluded)
const CLOCKWISE = [0, 1, 2, 5, 8, 7, 6, 3];
const STEP_MS = 100;
const DURATION_MS = CLOCKWISE.length * STEP_MS;

interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  color?: string;
}

function Spinner({ className, color = "var(--accent-color)", ...props }: SpinnerProps) {
  return (
    <div
      aria-label="Loading"
      role="status"
      className={cn("grid grid-cols-3 gap-px flex-shrink-0", className)}
      {...props}
    >
      {Array.from({ length: 9 }).map((_, i) => {
        if (i === 4) {
          return (
            <div
              key={i}
              style={{ backgroundColor: color, opacity: 0.12 }}
            />
          );
        }
        const lightIndex = CLOCKWISE.indexOf(i);
        return (
          <div
            key={i}
            className="animate-grid-spinner"
            style={{ backgroundColor: color, animationDelay: `${lightIndex * STEP_MS}ms`, animationDuration: `${DURATION_MS}ms` }}
          />
        );
      })}
    </div>
  );
}

export { Spinner };
