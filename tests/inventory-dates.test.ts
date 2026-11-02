import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  defaultInventoryRange,
  propertyLocalDateKey,
} from "../src/features/inventory/inventoryDates";

describe("Inventory property-local dates", () => {
  it("derives defaults from the property's IANA time zone rather than UTC", () => {
    const now = new Date("2026-01-01T05:30:00.000Z");

    expect(propertyLocalDateKey("Pacific/Honolulu", now)).toBe("2025-12-31");
    expect(defaultInventoryRange("Pacific/Honolulu", now)).toEqual({
      arrival: "2026-01-01",
      departure: "2026-01-03",
    });

    expect(propertyLocalDateKey("Pacific/Kiritimati", now)).toBe("2026-01-01");
    expect(defaultInventoryRange("Pacific/Kiritimati", now)).toEqual({
      arrival: "2026-01-02",
      departure: "2026-01-04",
    });
  });

  it("adds calendar days without crossing through the browser's local time zone", () => {
    expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addCalendarDays("2028-02-29", 2)).toBe("2028-03-02");
    expect(() => addCalendarDays("02/29/2028", 1)).toThrow(/invalid date key/i);
  });
});
