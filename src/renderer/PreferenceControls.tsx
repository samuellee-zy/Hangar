import { useId, type ReactNode } from 'react';

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
}: {
  name: string;
  note?: string;
  path: string;
  value: boolean;
  pending?: boolean;
}) {
  const id = useId();
  return (
    <Row id={id} name={name} note={note} pending={pending}>
      <input
        id={id}
        {...describedBy(id, note, pending)}
        type="checkbox"
        checked={value}
        disabled={pending}
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
}: {
  name: string;
  note?: string;
  path: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  pending?: boolean;
}) {
  const id = useId();
  return (
    <Row id={id} name={name} note={note} pending={pending}>
      <input
        id={id}
        {...describedBy(id, note, pending)}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={pending}
        style={{ width: 82 }}
        // Clamped here as well as in main: a number input happily emits out-of-range values when
        // typed rather than stepped.
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) set(path, Math.min(max, Math.max(min, n)));
        }}
      />
    </Row>
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
