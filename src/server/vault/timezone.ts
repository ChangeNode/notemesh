import { getSetting } from "../db";

// "Today" has to be resolved in the user's timezone, not the server's. A
// container runs in UTC, so an evening in the Americas is already tomorrow as
// far as the process is concerned and the daily note lands on the wrong day.
// Listings print modification times in the same zone, for the same reason.
export const DEFAULT_TIMEZONE = "UTC";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function configuredTimeZone(): string {
  const tz = getSetting("timezone");
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}
