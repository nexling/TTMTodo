export const INBOX_COMPACT_KEY = "magictodo:inbox-compact";
export const INBOX_COMPACT_NOTES_KEY = "magictodo:inbox-compact-notes";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function readInboxCompact(): boolean {
  return readFlag(INBOX_COMPACT_KEY);
}

export function writeInboxCompact(value: boolean): void {
  writeFlag(INBOX_COMPACT_KEY, value);
}

export function readInboxCompactNotes(): boolean {
  return readFlag(INBOX_COMPACT_NOTES_KEY);
}

export function writeInboxCompactNotes(value: boolean): void {
  writeFlag(INBOX_COMPACT_NOTES_KEY, value);
}
