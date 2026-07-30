import { useEffect, useState } from 'react';

/**
 * A text field that commits on blur or Enter rather than on every keystroke.
 *
 * The naive version sent a command per character, which meant a full `config.json` write per
 * character *and* a controlled input racing the state broadcast coming back — the cursor could
 * jump mid-word. Local state while editing, one command when you're done.
 */
export function CommitOnBlur({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  // Follow external changes (a rename from the context menu, an imported config) but only while
  // this field isn't the one being edited.
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };

  return (
    <input
      className="field grow"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}
