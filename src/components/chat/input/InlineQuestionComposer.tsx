import { useState, useCallback, useEffect, useRef } from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "../../../lib/cn";
import { Button } from "../../ui/button";
import type { AskQuestion } from "../types";

interface InlineQuestionComposerProps {
  questions: AskQuestion[];
  onAnswer: (answer: Record<string, string>) => void;
}

export function InlineQuestionComposer({ questions, onAnswer }: InlineQuestionComposerProps) {
  const [selected, setSelected] = useState<Record<number, string>>({});
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const isSingle = questions.length === 1;

  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  const handleSelect = useCallback(
    (qi: number, label: string) => {
      if (isSingle) {
        const q = questions[0];
        if (!q) return;
        onAnswer({ [q.question]: label });
        return;
      }
      setSelected((prev) => ({ ...prev, [qi]: label }));
      // Auto-advance on last question
      if (qi === questions.length - 1) {
        autoAdvanceTimerRef.current = window.setTimeout(() => {
          autoAdvanceTimerRef.current = null;
          setSelected((prev) => {
            const answers: Record<string, string> = {};
            questions.forEach((q, i) => {
              const answer = i === qi ? label : prev[i];
              if (answer) answers[q.question] = answer;
            });
            if (Object.keys(answers).length === questions.length) {
              onAnswer(answers);
            }
            return prev;
          });
        }, 200);
      }
    },
    [isSingle, questions, onAnswer],
  );

  // Keyboard shortcut: digit keys 1-9 select options for the first unanswered question
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLElement && target.isContentEditable) return;
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      // Find first unanswered question
      const qi = isSingle ? 0 : questions.findIndex((_, i) => selected[i] == null);
      if (qi < 0) return;
      const q = questions[qi];
      if (!q?.options) return;
      const option = q.options[digit - 1];
      if (!option) return;
      event.preventDefault();
      handleSelect(qi, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isSingle, questions, selected, handleSelect]);

  const allAnswered = !isSingle && questions.every((_, qi) => selected[qi] != null);

  const handleSubmit = () => {
    if (!allAnswered) return;
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      const answer = selected[qi];
      if (answer) answers[q.question] = answer;
    });
    onAnswer(answers);
  };

  return (
    <div className="px-4 py-3 sm:px-5 space-y-4">
      {questions.map((q, qi) => {
        const isAnswered = selected[qi] != null;
        return (
          <div key={qi}>
            {q.header && (
              <p className="text-[11px] font-semibold tracking-widest text-muted-foreground/50 uppercase mb-1.5">
                {q.header}
              </p>
            )}
            <p className="text-sm text-foreground/90 mb-3">{q.question}</p>
            {q.options && q.options.length > 0 && (
              <div className="space-y-1">
                {q.options.map((opt, oi) => {
                  const isSelected = selected[qi] === opt.label;
                  const shortcutKey = oi < 9 ? oi + 1 : null;
                  return (
                    <button
                      key={oi}
                      type="button"
                      onClick={() => handleSelect(qi, opt.label)}
                      className={cn(
                        "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all duration-150",
                        isSelected
                          ? "border-primary/40 bg-primary/8 text-foreground"
                          : "border-transparent bg-muted/20 text-foreground/80 hover:bg-muted/40 hover:border-border/40",
                        isAnswered && !isSelected && "opacity-50",
                      )}
                    >
                      {shortcutKey !== null && (
                        <kbd
                          className={cn(
                            "flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-medium tabular-nums transition-colors duration-150",
                            isSelected
                              ? "bg-primary/20 text-primary"
                              : "bg-muted/40 text-muted-foreground/50 group-hover:bg-muted/60 group-hover:text-muted-foreground/70",
                          )}
                        >
                          {shortcutKey}
                        </kbd>
                      )}
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-medium">{opt.label}</span>
                        {opt.description && opt.description !== opt.label && (
                          <span className="ml-3 text-xs text-muted-foreground/50">
                            {opt.description}
                          </span>
                        )}
                      </div>
                      {isSelected && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {!isSingle && (
        <div className="flex items-center justify-between pt-1">
          <p className="text-xs text-muted-foreground/50">Or reply using the input below.</p>
          <Button size="sm" disabled={!allAnswered} onClick={handleSubmit}>
            Submit
          </Button>
        </div>
      )}
      {isSingle && (
        <p className="text-xs text-muted-foreground/50">Or type a custom reply below.</p>
      )}
    </div>
  );
}
