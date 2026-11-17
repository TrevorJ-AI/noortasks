import type { ReactNode } from "react";
import { siApple, siGooglecalendar, siGoogletasks, siIcloud, siMarkdown, siNotion, siThings, siTodoist, siTrello } from "simple-icons";

/** Brand marks from simple-icons (CC0), only as small logos on factual "connect to / import from" cards. */
export const BRANDS = { apple: siApple, gcal: siGooglecalendar, gtasks: siGoogletasks, icloud: siIcloud, markdown: siMarkdown, notion: siNotion, things: siThings, todoist: siTodoist, trello: siTrello };

export function BrandTile({ brand }: { brand: keyof typeof BRANDS }): JSX.Element {
  const icon = BRANDS[brand];
  return (
    <span className="int-tile brand" aria-hidden>
      <svg viewBox="0 0 24 24" width="15" height="15">
        <path d={icon.path} fill={`#${icon.hex}`} />
      </svg>
    </span>
  );
}

/** Neutral tile (our own colour plus a line icon) where no brand mark is available or none applies. */
export function GlyphTile({ color, children }: { color: string; children: ReactNode }): JSX.Element {
  return (
    <span className="int-tile" style={{ background: color }} aria-hidden>
      {children}
    </span>
  );
}
