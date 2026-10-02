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
  assigneeOf?: (item: T) => string | null | undefined;
  assigneeUserId?: string | null;
}): string | null {
  const { items, draggedId, departmentId, column, dropOnId, idOf, deptOf, sortOf, columnOf, assigneeOf, assigneeUserId } =
    opts;
  if (dropOnId && dropOnId !== draggedId) return dropOnId;
  const dept = items
    .filter((item) => idOf(item) !== draggedId && (deptOf(item) || null) === (departmentId || null))
    .filter((item) => !assigneeOf || (assigneeOf(item) || null) === (assigneeUserId || null))
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

export function cellAppendBlockBeforeId<T>(opts: {
  items: T[];
  movingIds: Set<string>;
  departmentId: string | null | undefined;
  destColumn: string | number;
  idOf: (item: T) => string;
  deptOf: (item: T) => string | null | undefined;
  sortOf: (item: T) => number;
  columnOf: (item: T) => string | number;
  assigneeOf?: (item: T) => string | null | undefined;
  assigneeUserId?: string | null;
}): string | null {
  const { items, movingIds, departmentId, destColumn, idOf, deptOf, sortOf, columnOf, assigneeOf, assigneeUserId } =
    opts;
  const dept = items
    .filter((item) => !movingIds.has(idOf(item)) && (deptOf(item) || null) === (departmentId || null))
    .filter((item) => !assigneeOf || (assigneeOf(item) || null) === (assigneeUserId || null))
    .sort((a, b) => sortOf(a) - sortOf(b) || idOf(a).localeCompare(idOf(b)));
  const inCell = dept.filter((item) => columnOf(item) === destColumn);
  const last = inCell[inCell.length - 1];
  if (!last) {
    const later = dept.find((item) => columnOf(item) > destColumn);
    return later ? idOf(later) : null;
  }
  const idx = dept.findIndex((item) => idOf(item) === idOf(last));
  return idx >= 0 && idx + 1 < dept.length ? idOf(dept[idx + 1]) : null;
}

export function applyTimeBlockShift<T extends { sort_order: number }>(opts: {
  items: T[];
  movingIds: Set<string>;
  idOf: (item: T) => string;
  deptOf: (item: T) => string | null | undefined;
  columnOf: (item: T) => string | number;
  shift: (item: T) => T;
}): T[] {
  const { items, movingIds, idOf, deptOf, columnOf, shift } = opts;
  const next = items.map((item) => (movingIds.has(idOf(item)) ? shift(item) : item));
  const byDept = new Map<string, T[]>();
  for (const item of next) {
    const key = deptOf(item) || "";
    const list = byDept.get(key) || [];
    list.push(item);
    byDept.set(key, list);
  }
  const rank = new Map<string, number>();
  for (const list of byDept.values()) {
    const cols = [...new Set(list.map(columnOf))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let index = 0;
    for (const col of cols) {
      const inCol = list.filter((item) => columnOf(item) === col);
      const staying = inCol
        .filter((item) => !movingIds.has(idOf(item)))
        .sort((a, b) => a.sort_order - b.sort_order || idOf(a).localeCompare(idOf(b)));
      const incoming = inCol
        .filter((item) => movingIds.has(idOf(item)))
        .sort((a, b) => a.sort_order - b.sort_order || idOf(a).localeCompare(idOf(b)));
      for (const item of [...staying, ...incoming]) {
        rank.set(idOf(item), index);
        index += 1;
      }
    }
  }
  return next.map((item) => {
    const order = rank.get(idOf(item));
    if (order === undefined || item.sort_order === order) return item;
    return { ...item, sort_order: order };
  });
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
