/**
 * A way out to the provider, to do what the page just said to do. It
 * opens in a new tab so the page you were reading is still there when
 * you come back to check the next move. On Android it is addressed to
 * the provider's app instead, which opens over this page, and the web
 * page is the fallback.
 */

import type { ComponentChildren } from "preact";

import { androidAppLink, onAndroid } from "../lib/deepLinks.ts";

export function GoLink(
  { href, children }: { href: string; children: ComponentChildren },
) {
  const app = onAndroid() ? androidAppLink(href) : null;

  return (
    <a
      class="golink" href={app ?? href} rel="noreferrer"
      {...(app ? {} : { target: "_blank" })}
    >
      {children}
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M6 3h7v7M13 3L5 11" fill="none" stroke="currentColor"
          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </a>
  );
}
