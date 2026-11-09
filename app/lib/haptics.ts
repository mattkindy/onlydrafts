/**
 * A light tap under the finger, where the phone allows one.
 *
 * Android browsers take navigator.vibrate. Safari on the iPhone has no
 * vibrate, but from iOS 18 it taps when a switch-style checkbox is
 * flipped, so a hidden one is flipped instead. Anywhere else nothing
 * happens, which is fine: a tap only ever adds to a control that already
 * shows its change on screen.
 */

/** long enough to feel, short enough to read as a click */
export const TICK_MS = 8;

interface Where {
  nav: Pick<Navigator, "vibrate"> | { vibrate?: undefined };
  doc: Document;
  /** whether the page is being used by touch, the only time a tap helps */
  touch: boolean;
}

function here(): Where {
  return {
    nav: navigator,
    doc: document,
    touch: typeof matchMedia === "function" &&
      matchMedia("(pointer: coarse)").matches,
  };
}

/** one tap, as a slider passes a notch */
export function tick(where: Where = here()) {
  if (!where.touch) {
    return;
  }

  try {
    if (typeof where.nav.vibrate === "function") {
      where.nav.vibrate(TICK_MS);
      return;
    }

    // Safari: flipping a switch taps, and clicking its label flips it
    const label = where.doc.createElement("label");
    const flip = where.doc.createElement("input");

    label.setAttribute("aria-hidden", "true");
    label.style.display = "none";
    flip.type = "checkbox";
    flip.setAttribute("switch", "");
    flip.tabIndex = -1;
    label.appendChild(flip);
    where.doc.head.appendChild(label);
    label.click();
    label.remove();
  } catch {
    // no tap is no loss
  }
}
