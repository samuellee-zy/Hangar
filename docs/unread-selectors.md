# Finding an unread selector

How to work out what a service's badge selector is, and how to know when you've got it wrong.

Eight catalog entries have an inbox worth counting and no rule for it: **Notion, Jira, Confluence,
Trello, Asana, ClickUp, Monday and Figma**. Every other rule-less entry has nothing to count.

They are missing on purpose. [decisions #90](decisions.md) is explicit that a rule is data rather
than a script precisely so that a wrong one is cheap to find and fix — but a *guessed* one is worse
than none, because it fails silently. A selector that matches nothing looks exactly like "you have
read everything", and the badge simply never appears. Nobody investigates a zero.

So each of these needs DevTools on a real, logged-in page. This is that procedure.

## What you are looking for

Two selectors, not one.

- **`selector`** — the element holding the count. Its text is parsed for digits, so `12`,
  `12 unread` and `9+` all work, and non-empty text with no digits reads as `1` (which is how a
  bare dot indicator counts).
- **`anchor`** — an element that proves the app finished rendering. This is the part people skip
  and it is the part that matters. Without it, "no badge" is ambiguous between *you are all caught
  up* and *the SPA hasn't drawn its sidebar yet*. Anchor present with no badge is a confirmed zero;
  anchor absent means the rule says nothing and the next rule gets a turn.

The model to copy is GitLab's, in `src/shared/catalog.ts`:

```ts
const GITLAB_UNREAD = {
  dom: [
    { selector: '[data-testid="todos-counter"]', anchor: '[data-testid="super-sidebar"]' },
    { selector: '.js-todos-count', anchor: 'header.navbar' },
  ],
};
```

Two rules, tried in order: current markup first, older self-hosted markup as the fallback. Each
carries its own anchor, because the thing that proves *that* version rendered is different.

## A count per row, and a title as well

Some services show a number on each conversation and never total them. WhatsApp's title says
"(1) WhatsApp" meaning one *chat*, while the chats hold 8 messages. For those, `read: 'sum'` adds up
the number in every match. A match with no number in it adds nothing, so a selector that also
catches an icon's label is harmless. See `WHATSAPP_MESSAGES` in `src/shared/catalog.ts`, which also
leaves muted chats out with `:not(:has(…) + * > span)`.

An entry can keep its `titlePattern` next to page rules, as WhatsApp does. The page is the count
once it has given a number; the title speaks until then, while the page loads, or for good if the
markup changes and the rule reads nothing. That only works if the page can decline to answer, so
every page rule on such an entry needs an `anchor`, and a test checks it.

Settings → Unread badges shows what each count was last read from: the title, the badge text
found, or why there was none. That is the quickest way to tell a wrong rule from a surprising number.

## The procedure

1. **Open the service in Hangar and sign in.** It has to be your real account — an empty inbox and
   a logged-out page both have no badge, and you cannot tell a working selector from a broken one
   against either.

2. **Get the badge into a known state.** Make sure there is at least one unread item and that you
   can see the number on screen. Note what it says.

3. **Open DevTools on the pane** and inspect the badge element. Right-click it → Inspect.

4. **Pick the most stable selector that matches it.** In order of preference:
   - `[data-testid="..."]` or any other attribute the vendor's own test suite uses. These break
     loudly for the vendor too, which is the best guarantee available.
   - A semantic attribute — `aria-label`, `role`, `data-*`.
   - A stable class name.
   - **Never** a generated class (`.css-1x2y3z`, `.sc-hKgILt`). Those change on every build.
   - **Never** a positional path (`div > div:nth-child(3) > span`).

5. **Check it in the console**, on the page itself:

   ```js
   document.querySelectorAll('YOUR_SELECTOR').length; // expect 1
   document.querySelector('YOUR_SELECTOR').textContent; // expect the number you noted
   ```

6. **Find an anchor.** Something that is always present once the app has rendered and is *not*
   related to the count — a sidebar container, the app shell, the nav. Verify it with
   `document.querySelector('YOUR_ANCHOR')`. It must not be the badge or an ancestor that only
   exists when there is a badge; a test asserts the anchor and selector are never the same string,
   but it cannot catch "the anchor only appears alongside the badge".

7. **Try it live, without a rebuild.** Settings → Unread badges → paste the selector into that
   service's field. It applies immediately, so put the settings window beside the service and watch
   the count. The `Default` button puts it back.

8. **Prove it can go down.** This is the whole point of the feature. Read one item and confirm the
   number drops. A selector that shows the right number once but never changes is matching a
   static element.

9. **Prove it can reach zero.** Read everything. The badge should clear rather than freeze at the
   last value — if it freezes, the anchor is wrong or missing.

## Then add it

Add the verified rule to the entry in `src/shared/catalog.ts`, with a comment saying *why* that
selector is stable — the GitLab comment's "this is the same hook their own suite asserts on" is the
standard to meet. `npm run check` enforces the rest: no entry may declare both a title pattern and
DOM rules, no rule may be an empty selector, and `read: 'attr'` must name an attribute.

## When there isn't one

Some of the eight may not have a usable badge at all. Figma in particular renders to canvas, and a
count drawn into a canvas is unreachable by any selector. If DevTools shows no DOM element holding
the number, that is a real answer: leave the entry alone rather than reaching for something
adjacent that happens to contain a digit.
