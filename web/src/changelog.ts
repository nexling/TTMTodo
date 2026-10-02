import changelogSource from "./content/changelog.md?raw";

const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})(?:\s|$)/;
const SEEN_KEY = "magictodo:changelog-seen";

export const CHANGELOG_MD = changelogSource;

export function newestChangelogDate(source: string = CHANGELOG_MD): string {
  let newest = "";
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(DATE_HEADING);
    if (match && match[1] > newest) newest = match[1];
  }
  return newest;
}

export function hasUnseenChangelog(): boolean {
  const newest = newestChangelogDate();
  if (!newest) return false;
  const seen = localStorage.getItem(SEEN_KEY);
  if (seen === null) return true;
  return newest > seen;
}

export function markChangelogSeen(): void {
  localStorage.setItem(SEEN_KEY, newestChangelogDate());
}
