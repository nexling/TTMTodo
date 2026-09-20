export function cellInsertBeforeId<T>(opts: {
  items: T[];
  draggedId: string;
  departmentId: string | null | undefined;
  column: string | number;
  dropOnId?: string | null;
  idOf: (item: T) => string;
  deptOf: (item: T) => string | null | undefined;
  sortOf: (item: T) => number;
  columnOf: (item: T) => string | number;
}): string | null {
  const { items, draggedId, departmentId, column, dropOnId, idOf, deptOf, sortOf, columnOf } = opts;
  if (dropOnId && dropOnId !== draggedId) return dropOnId;
  const dept = items
    .filter((item) => idOf(item) !== draggedId && (deptOf(item) || null) === (departmentId || null))
    .sort((a, b) => sortOf(a) - sortOf(b) || idOf(a).localeCompare(idOf(b)));
  const inCell = dept.filter((item) => columnOf(item) === column);
  const last = inCell[inCell.length - 1];
  if (!last) {
    const later = dept.find((item) => columnOf(item) > column);
    return later ? idOf(later) : null;
  }
  const idx = dept.findIndex((item) => idOf(item) === idOf(last));
  return idx >= 0 && idx + 1 < dept.length ? idOf(dept[idx + 1]) : null;
}

export function orderDepartmentIds<T>(opts: {
  items: T[];
  draggedId: string;
  departmentId: string | null | undefined;
  beforeId: string | null;
  idOf: (item: T) => string;
  deptOf: (item: T) => string | null | undefined;
  sortOf: (item: T) => number;
}): string[] {
  const { items, draggedId, departmentId, beforeId, idOf, deptOf, sortOf } = opts;
  const ids = items
    .filter((item) => idOf(item) !== draggedId && (deptOf(item) || null) === (departmentId || null))
    .sort((a, b) => sortOf(a) - sortOf(b) || idOf(a).localeCompare(idOf(b)))
    .map(idOf);
  if (beforeId && ids.includes(beforeId)) {
    ids.splice(ids.indexOf(beforeId), 0, draggedId);
  } else {
    ids.push(draggedId);
  }
  return ids;
}

export function applyDepartmentSort<T extends { sort_order: number }>(
  items: T[],
  departmentId: string | null | undefined,
  orderedIds: string[],
  idOf: (item: T) => string,
  deptOf: (item: T) => string | null | undefined,
): T[] {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  return items.map((item) => {
    if ((deptOf(item) || null) !== (departmentId || null)) return item;
    const next = rank.get(idOf(item));
    if (next === undefined || item.sort_order === next) return item;
    return { ...item, sort_order: next };
  });
}

export function nextDeptSort<T>(
  items: T[],
  departmentId: string | null | undefined,
  deptOf: (item: T) => string | null | undefined,
  sortOf: (item: T) => number,
): number {
  let max = -1;
  for (const item of items) {
    if ((deptOf(item) || null) !== (departmentId || null)) continue;
    max = Math.max(max, sortOf(item));
  }
  return max + 1;
}
