import { describe, expect, it, vi } from "vitest";

import { TICK_MS, tick } from "./haptics.ts";

describe("tick", () => {
  it("vibrates briefly where the browser can", () => {
    const vibrate = vi.fn(() => true);

    tick({ nav: { vibrate }, doc: document, touch: true });

    expect(vibrate).toHaveBeenCalledWith(TICK_MS);
  });

  it("flips a hidden switch where it cannot, and leaves nothing behind", () => {
    const flipped: boolean[] = [];
    const listen = (e: Event) => {
      const box = e.target as HTMLInputElement;

      if (box.type === "checkbox" && box.hasAttribute("switch")) {
        flipped.push(box.checked);
      }
    };

    document.addEventListener("change", listen, true);
    const before = document.head.children.length;

    tick({ nav: {}, doc: document, touch: true });

    document.removeEventListener("change", listen, true);
    expect(flipped).toEqual([true]);
    expect(document.head.children.length).toBe(before);
  });

  it("stays still with a mouse", () => {
    const vibrate = vi.fn(() => true);

    tick({ nav: { vibrate }, doc: document, touch: false });

    expect(vibrate).not.toHaveBeenCalled();
  });
});
