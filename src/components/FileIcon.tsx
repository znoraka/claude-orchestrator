interface FileIconProps {
  filename: string;
  size?: number;
}

type IconDef = { color: string; letter?: string };

function getIconDef(filename: string): IconDef {
  const name = filename.split("/").pop() || filename;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";

  // Lock files
  if (ext === ".lock" || name === "package-lock.json" || name === "yarn.lock")
    return { color: "#6b7280", letter: "L" };

  switch (ext) {
    case ".ts":
    case ".tsx":
      return { color: "#3b82f6", letter: "TS" };
    case ".js":
    case ".jsx":
      return { color: "#eab308", letter: "JS" };
    case ".rs":
      return { color: "#f97316", letter: "R" };
    case ".css":
    case ".scss":
    case ".less":
      return { color: "#a855f7", letter: "S" };
    case ".html":
      return { color: "#ef4444", letter: "H" };
    case ".json":
    case ".yaml":
    case ".yml":
    case ".toml":
      return { color: "#22c55e", letter: "C" };
    case ".md":
      return { color: "#9ca3af", letter: "M" };
    case ".py":
      return { color: "#3b82f6", letter: "Py" };
    case ".svg":
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".webp":
      return { color: "#ec4899", letter: "I" };
    case ".go":
      return { color: "#06b6d4", letter: "Go" };
    case ".sh":
    case ".bash":
    case ".zsh":
      return { color: "#22c55e", letter: "#" };
    default:
      return { color: "#6b7280" };
  }
}

export default function FileIcon({ filename, size = 14 }: FileIconProps) {
  const { color, letter } = getIconDef(filename);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="flex-shrink-0"
    >
      {/* Document shape with folded corner */}
      <path
        d="M3 1h7l3 3v11H3V1z"
        fill={color}
        fillOpacity={0.08}
        stroke={color}
        strokeOpacity={0.6}
        strokeWidth={0.75}
        strokeLinejoin="round"
      />
      <path
        d="M10 1v3h3"
        stroke={color}
        strokeOpacity={0.6}
        strokeWidth={0.75}
        strokeLinejoin="round"
      />
      {/* Extension letter */}
      {letter && (
        <text
          x="6.5"
          y="12"
          textAnchor="middle"
          fill={color}
          fillOpacity={0.85}
          fontSize={letter.length > 2 ? "4.5" : letter.length > 1 ? "5.5" : "7"}
          fontWeight="600"
          fontFamily="system-ui, sans-serif"
        >
          {letter}
        </text>
      )}
    </svg>
  );
}
