import { createContext, useContext, useCallback, useState, useRef, type ReactNode } from "react";

interface ToastMessage {
  id: number;
  text: string;
  type: "error" | "info";
}

interface ToastContextValue {
  showError: (text: string) => void;
  showInfo: (text: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(0);

  const addToast = useCallback((text: string, type: "error" | "info") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, text, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const showError = useCallback((text: string) => addToast(text, "error"), [addToast]);
  const showInfo = useCallback((text: string) => addToast(text, "info"), [addToast]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showError, showInfo }}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`flex items-start gap-2 px-4 py-3 rounded-lg shadow-lg text-xs border animate-slide-in ${
                toast.type === "error"
                  ? "bg-red-950/90 border-red-800/50 text-red-200"
                  : "bg-[var(--bg-secondary)] border-[var(--border-color)] text-[var(--text-primary)]"
              }`}
            >
              <span className="flex-1 break-words">{toast.text}</span>
              <button
                onClick={() => dismiss(toast.id)}
                className="shrink-0 text-current opacity-50 hover:opacity-100"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
