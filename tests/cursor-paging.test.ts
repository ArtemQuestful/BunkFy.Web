import { describe, expect, it } from "vitest";
import {
  canAdvanceCursor,
  initialCursorPage,
  nextCursorPage,
  previousCursorPage,
} from "../src/features/inventory/cursorPaging";

describe("opaque cursor paging", () => {
  it("retains exact opaque cursors for deterministic forward and back navigation", () => {
    const first = initialCursorPage();
    const second = nextCursorPage(first, "opaque:page-2");
    const third = nextCursorPage(second, "opaque:page-3");

    expect(third).toEqual({
      page: 3,
      cursor: "opaque:page-3",
      previousCursors: [null, "opaque:page-2"],
    });
    expect(previousCursorPage(third)).toEqual(second);
    expect(previousCursorPage(second)).toEqual(first);
  });

  it("does not advance without a new server cursor", () => {
    const current = nextCursorPage(initialCursorPage(), "opaque:page-2");
    expect(nextCursorPage(current, null)).toBe(current);
    expect(nextCursorPage(current, "opaque:page-2")).toBe(current);
  });

  it("refuses a server cursor that cycles back to an already visited page", () => {
    const second = nextCursorPage(initialCursorPage(), "opaque:page-2");
    const third = nextCursorPage(second, "opaque:page-3");

    expect(canAdvanceCursor(third, "opaque:page-2")).toBe(false);
    expect(nextCursorPage(third, "opaque:page-2")).toBe(third);
  });
});
