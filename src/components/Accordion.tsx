import { createContext, createSignal, createUniqueId, onMount, useContext, type JSX } from "solid-js";

/**
 * A button-and-panel accordion, in the shape of the W3Schools example: a
 * `<button class="accordion">` followed by the `<div class="panel">` it
 * discloses, `.active` marking the open button, and a `+`/`−` marker supplied
 * by CSS.
 *
 * It replaces `<details name="connect" role="button">`. That markup rendered
 * wrong for a reason worth recording, because it is easy to write again: the
 * role sat on the `<details>` rather than on its `<summary>`, so Pico painted
 * the entire disclosure as a button face — heading and body together — and
 * assistive technology announced the whole panel, endpoint URL and copy button
 * and all, as one button's label. Splitting the control from the content makes
 * that particular mistake unavailable.
 *
 * What is kept from the old behaviour, and deliberately differs from the
 * W3Schools version: panels are exclusive. Opening one closes its siblings,
 * which the shared `name` attribute used to do natively. These panels are
 * alternative answers to the same question — which client are you connecting? —
 * so two open at once is just a longer page to scroll past the part you need.
 * W3Schools' panels are independent, which suits a FAQ and not this.
 *
 * What is given up by leaving `<details>`: the panels no longer open without
 * JavaScript, and the browser's find-in-page will not reveal a closed one. This
 * is an admin dashboard that is already a client-rendered SPA, so neither costs
 * anything here — but they would matter on a content page, and this component
 * should not be lifted onto one without that in mind.
 */

type Group = {
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  open: (id: string) => void;
};

const GroupContext = createContext<Group>();

export function Accordion(props: { children: JSX.Element }) {
  // One id rather than a set: exclusivity is the whole state model, so there is
  // nothing to keep in sync and no way for two to be open at once.
  const [openId, setOpenId] = createSignal<string | null>(null);

  const group: Group = {
    isOpen: (id) => openId() === id,
    open: (id) => setOpenId(id),
    toggle: (id) => setOpenId(openId() === id ? null : id),
  };

  return <GroupContext.Provider value={group}>{props.children}</GroupContext.Provider>;
}

export function AccordionPanel(props: { summary: JSX.Element; open?: boolean; children: JSX.Element }) {
  const group = useContext(GroupContext);
  if (!group) throw new Error("<AccordionPanel> must be rendered inside an <Accordion>.");

  const panelId = createUniqueId();
  const buttonId = createUniqueId();

  // On mount rather than as the signal's initial value, because the panel that
  // starts open is a fact about one child and the signal belongs to the parent.
  // Two panels marked open would leave the last one showing, which is the same
  // resolution the `open` attribute had on sibling `<details>`.
  onMount(() => {
    if (props.open) group.open(panelId);
  });

  const expanded = () => group.isOpen(panelId);

  return (
    <>
      <button
        type="button"
        id={buttonId}
        class="accordion"
        classList={{ active: expanded() }}
        aria-expanded={expanded()}
        aria-controls={panelId}
        onClick={() => group.toggle(panelId)}
      >
        {props.summary}
      </button>
      {/* Kept in the DOM and hidden with `display: none`, as the example does.
          The content is small, and rendering it eagerly means a panel costs
          nothing to open. `role="region"` needs a name, which the button
          supplies — without it a screen reader announces an unlabelled group. */}
      <div id={panelId} class="panel" classList={{ open: expanded() }} role="region" aria-labelledby={buttonId}>
        {props.children}
      </div>
    </>
  );
}
