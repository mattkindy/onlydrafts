/** Turns whatever the page is showing into a picture for the group chat. */

export function ShareButton(
  { onShare, label, only }: {
    onShare: () => void;
    label: string;
    /** the icon on its own, for a card with no room for a word */
    only?: boolean;
  },
) {
  return (
    <button
      class={"quiet share" + (only ? " icon" : "")}
      title="save this as a picture for the group chat"
      aria-label={label}
      onClick={onShare}
    >
      <span aria-hidden="true">&#x2934;</span>
      {!only && label}
    </button>
  );
}
