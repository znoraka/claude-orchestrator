import { useState } from "react";
import type { AskQuestion } from "../types";

interface InlineQuestionComposerProps {
  questions: AskQuestion[];
  onAnswer: (answer: Record<string, string>) => void;
}

export function InlineQuestionComposer({ questions, onAnswer }: InlineQuestionComposerProps) {
  const [selected, setSelected] = useState<Record<number, string>>({});
  const isSingle = questions.length === 1;

  const handleSelect = (qi: number, label: string) => {
    if (isSingle) {
      onAnswer({ [questions[0].question]: label });
    } else {
      setSelected((prev) => ({ ...prev, [qi]: label }));
    }
  };

  const allAnswered = !isSingle && questions.every((_, qi) => selected[qi] != null);

  const handleSubmit = () => {
    if (!allAnswered) return;
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => { answers[q.question] = selected[qi]; });
    onAnswer(answers);
  };

  return (
    <div className="flex flex-col gap-2">
      {questions.map((q, qi) => (
        <div key={qi} className="flex flex-col gap-1.5">
          {q.header && (
            <div className="text-[10px] font-semibold text-[var(--accent)] uppercase tracking-wide">{q.header}</div>
          )}
          <div className="text-xs text-[var(--text-secondary)]">{q.question}</div>
          {q.options && q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt, oi) => {
                const isSelected = selected[qi] === opt.label;
                return (
                  <button
                    key={oi}
                    onClick={() => handleSelect(qi, opt.label)}
                    title={opt.description}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${isSelected ? "bg-[var(--accent)] text-white" : "bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--accent)]/15 hover:text-[var(--accent)]"}`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      <div className="text-xs text-[var(--text-tertiary)]">
        Or reply using the main input below.
      </div>
      {!isSingle && (
        <button
          disabled={!allAnswered}
          onClick={handleSubmit}
          className={`self-end px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${allAnswered ? "bg-[var(--accent)] text-white hover:bg-[var(--accent)]/90" : "bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] cursor-not-allowed"}`}
        >
          Submit
        </button>
      )}
    </div>
  );
}
