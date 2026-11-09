/**
 * What every sheet over the page does on a phone: it holds the page
 * still underneath, and it goes away when you pull it down.
 *
 * A sheet that rises from the bottom invites the swipe that sends it
 * back, and without one the only way out was a small cross in the far
 * corner, the one place on a phone a thumb does not rest. The pull only
 * starts with the sheet scrolled to its top, so reading down a long one
 * never closes it by accident.
 */

import { useEffect, useRef } from "preact/hooks";

/** how far a pull has to travel before letting go closes the sheet */
const CLOSES_AT = 90;

export function useSheet(onClose: () => void) {
  const sheet = useRef<HTMLDivElement>(null);
  const closing = useRef(onClose);

  closing.current = onClose;

  useEffect(() => {
    const { body } = document;
    const was = body.style.overflow;

    body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closing.current();
      }
    };

    window.addEventListener("keydown", onKey);

    return () => {
      body.style.overflow = was;
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    const at = sheet.current;

    if (!at) {
      return;
    }

    let from: number | null = null;
    let pulled = 0;

    const start = (e: TouchEvent) => {
      from = at.scrollTop <= 0 ? e.touches[0]!.clientY : null;
      pulled = 0;
    };

    const move = (e: TouchEvent) => {
      if (from === null) {
        return;
      }

      pulled = Math.max(0, e.touches[0]!.clientY - from);

      if (pulled > 0) {
        at.style.transition = "none";
        at.style.transform = `translateY(${pulled}px)`;
      }
    };

    const end = () => {
      if (from === null) {
        return;
      }

      from = null;
      at.style.transition = "";
      at.style.transform = "";

      if (pulled > CLOSES_AT) {
        closing.current();
      }
    };

    at.addEventListener("touchstart", start, { passive: true });
    at.addEventListener("touchmove", move, { passive: true });
    at.addEventListener("touchend", end);
    at.addEventListener("touchcancel", end);

    return () => {
      at.removeEventListener("touchstart", start);
      at.removeEventListener("touchmove", move);
      at.removeEventListener("touchend", end);
      at.removeEventListener("touchcancel", end);
    };
  }, []);

  return sheet;
}
