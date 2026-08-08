import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

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
  allowEmpty = false,
  ...input
}: {
  value: string;
  onCommit: (next: string) => void;
  /**
   * Whether clearing the field is a value rather than an abandoned edit.
   *
   * Off by default, and that default is the right one for a name: emptying the workspace field and
   * clicking away is a slip, not a request for a workspace called "". It is wrong for the unread
   * selector, where empty is the deliberate "detect nothing" — so that field opts in and gets to
   * distinguish empty from unset.
   */
  allowEmpty?: boolean;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onBlur' | 'onKeyDown' | 'onFocus'
>) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);

  // Follow external changes (a rename from the context menu, an imported config) but only while
  // this field isn't the one being edited.
  //
  // The guard is the whole point and was missing: `value` changes on *every* ShellState broadcast
  // this field's section re-renders for — a sync status tick, a rail reorder, an unrelated
  // preference write — and each one reset the draft to the committed value mid-word.
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  const commit = () => {
    editing.current = false;
    const next = draft.trim();
    if ((next || allowEmpty) && next !== value) onCommit(next);
    else setDraft(value);
  };

  return (
    <input
      className="field grow"
      {...input}
      value={draft}
      onFocus={() => {
        editing.current = true;
      }}
      // Also on change, not only on focus: Escape clears the flag while the field keeps focus, and
      // typing after that has to re-arm it or the next broadcast clobbers the second attempt.
      onChange={(e) => {
        editing.current = true;
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          // Deliberately no `blur()`. Blurring runs `commit`, which closes over the *current*
          // render's `draft` — still the abandoned text, because `setDraft` hasn't re-rendered yet.
          // So escaping an edit committed the very value it was discarding.
          editing.current = false;
          setDraft(value);
        }
      }}
    />
  );
}
