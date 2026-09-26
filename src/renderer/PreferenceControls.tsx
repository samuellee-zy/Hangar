import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';

/**
 * Thin wrappers over native inputs. They send a `set-preference` command and nothing else — main
 * validates the path and type, and the resulting broadcast re-renders us. No local state, so the
 * control can never disagree with what's actually stored.
 *
 * `pending` marks a preference that's persisted but whose effect isn't implemented yet. Showing it
 * greyed with an honest note beats hiding it (the shape of the app stays visible) and beats
 * shipping a control that silently does nothing.
 */

const set = (path: string, value: unknown) =>
  window.hangar.send({ type: 'set-preference', path, value });

/**
 * The name is a real `<label>` tied to the control, not a span beside it.
 *
 * It was a span, which meant every preference in Settings was an unlabelled input: VoiceOver
 * announced forty "checkbox, unchecked" rows in a column, and clicking a name did nothing. The
 * layout is unchanged — a label is inline like the span was — so this is purely the association
 * that was missing.
 *
 * The note is wired through `aria-describedby` for the same reason: "Needs a packaged, code-signed
 * build" is the part that explains why a toggle appears to do nothing, and it was announced as
 * unrelated text if at all.
 */
function Row({
  id,
  name,
  note,
  pending,
  children,
}: {
  id: string;
  name: string;
  note?: string;
  pending?: boolean;
  children: ReactNode;
}) {
  const showNote = Boolean(note || pending);
  return (
    <li className={`pref${pending ? ' is-pending' : ''}`}>
      <span className="pref-label">
        <label className="pref-name" htmlFor={id}>
          {name}
        </label>
        {showNote && (
          <span className="pref-note" id={`${id}-note`}>
            {note}
          </span>
        )}
      </span>
      {children}
    </li>
  );
}

/** The attributes every control needs to be described by its own note. */
const describedBy = (id: string, note?: string, pending?: boolean) =>
  note || pending ? { 'aria-describedby': `${id}-note` } : {};

export function Toggle({
  name,
  note,
  path,
  value,
  pending,
  disabled,
}: {
  name: string;
  note?: string;
  path: string;
  value: boolean;
  pending?: boolean;
  /** Off because another setting makes this one meaningless — the note should say which. */
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Row id={id} name={name} note={note} pending={pending}>
      <input
        id={id}
        {...describedBy(id, note, pending)}
        type="checkbox"
        checked={value}
        disabled={pending || disabled}
        onChange={(e) => set(path, e.target.checked)}
      />
    </Row>
  );
}

export function Choice<T extends string>({
  name,
  note,
  path,
  value,
  options,
  pending,
}: {
  name: string;
  note?: string;
  path: string;
  value: T;
  options: readonly T[];
  pending?: boolean;
}) {
  const id = useId();
  return (
    <Row id={id} name={name} note={note} pending={pending}>
      <select
        id={id}
        {...describedBy(id, note, pending)}
        value={value}
        disabled={pending}
        onChange={(e) => set(path, e.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function Num({
  name,
  note,
  path,
  value,
  min,
  max,
  step = 1,
  pending,
  disabled,
}: {
  name: string;
  note?: string;
  path: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  pending?: boolean;
  /** Off because another setting makes this one meaningless — the note should say which. */
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Row id={id} name={name} note={note} pending={pending}>
      <NumberField
        id={id}
        {...describedBy(id, note, pending)}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={pending || disabled}
        onCommit={(n) => set(path, n)}
      />
    </Row>
  );
}

/** How long a valid value sits before it is applied, so the spinner arrows still feel live. */
const NUMBER_SETTLE_MS = 250;

/**
 * A number that can be typed.
 *
 * It clamped on every keystroke. With a minimum of 56, typing "7" on the way to "72" became 56 on the
 * spot, and the next keystroke made it 566 — clamped to the maximum. A rail size could not be typed
 * at all, and every keystroke also wrote the config and re-laid out the window.
 *
 * Now the text is yours while you type. A value is applied once it is a number *inside* the range,
 * after a short pause; leaving the field — or Enter — clamps whatever is there, and Escape or an
 * empty field puts the current value back.
 */
export function NumberField({
  value,
  min,
  max,
  onCommit,
  ...input
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (next: number) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'min' | 'max' | 'onChange' | 'onBlur' | 'type'>) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow outside changes — a reset, a sync — but never while this is the field being typed in.
  useEffect(() => {
    if (!editing.current) setDraft(String(value));
  }, [value]);
  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current);
  }, []);

  const cancelSettle = () => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = null;
  };

  const finish = (text: string) => {
    cancelSettle();
    editing.current = false;
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      {...input}
      type="number"
      min={min}
      max={max}
      style={{ width: 82, ...input.style }}
      value={draft}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(e) => {
        editing.current = true;
        const text = e.target.value;
        setDraft(text);
        cancelSettle();
        const n = Number(text);
        if (text.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && n !== value) {
          settle.current = setTimeout(() => onCommit(n), NUMBER_SETTLE_MS);
        }
      }}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish((e.target as HTMLInputElement).value);
        if (e.key === 'Escape') {
          cancelSettle();
          editing.current = false;
          setDraft(String(value));
        }
      }}
    />
  );
}

/**
 * A free-text preference, committed on blur rather than on every keystroke.
 *
 * Per-keystroke would write the config file — and, for the Firebase fields, tear down and retry a
 * registration — on every character typed. `defaultValue` with a `key` lets the field hold
 * uncommitted text without the component fighting the broadcast that follows a commit.
 */
export function Text({
  name,
  note,
  path,
  value,
  placeholder,
  password,
  pending,
}: {
  name: string;
  note?: string;
  path: string;
  value: string;
  placeholder?: string;
  /** Masks the value. Used for the Firebase apiKey, which is a credential in a shared screenshot. */
  password?: boolean;
  pending?: boolean;
}) {
  const id = useId();
  return (
    <Row id={id} name={name} note={note} pending={pending}>
      <input
        id={id}
        {...describedBy(id, note, pending)}
        key={value}
        type={password ? 'password' : 'text'}
        defaultValue={value}
        placeholder={placeholder}
        disabled={pending}
        spellCheck={false}
        style={{ width: 220 }}
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next !== value) set(path, next);
        }}
        // Enter should commit too — blurring is not obvious as the way to save.
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </Row>
  );
}
