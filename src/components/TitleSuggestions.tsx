import { useEffect, useState } from 'react';
import { suggestTitles } from '../services/titleSuggestions';

interface TitleSuggestionsProps {
  conversationId: string;
  onPick: (title: string) => void;
}

/** Three model-suggested titles for the rename dialog, fetched when it opens. */
export function TitleSuggestions({ conversationId, onPick }: TitleSuggestionsProps) {
  const [titles, setTitles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setTitles(null);
    setError(null);
    suggestTitles(conversationId, controller.signal)
      .then(setTitles)
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [conversationId]);

  if (error) return <p className="title-suggestions-status">{error}</p>;
  if (titles === null) return <p className="title-suggestions-status">Suggesting titles…</p>;
  if (titles.length === 0) return null;
  return (
    <div className="title-suggestions" role="group" aria-label="Suggested titles">
      {titles.map(title => (
        <button key={title} type="button" className="title-suggestion" onClick={() => onPick(title)}>
          {title}
        </button>
      ))}
    </div>
  );
}
