import type { Bucket } from "./api";

export function bucketParentKey(id: string | null | undefined): string | null {
  return id || null;
}

export function bucketChildren(buckets: Bucket[], parentId: string | null): Bucket[] {
  return buckets
    .filter((bucket) => bucketParentKey(bucket.parent_id) === parentId)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

export function walkBucketTree(
  buckets: Bucket[],
  opts?: { folded?: Set<string>; parentId?: string | null; depth?: number },
): { bucket: Bucket; depth: number; hasChildren: boolean }[] {
  const folded = opts?.folded ?? new Set<string>();
  const parentId = opts?.parentId ?? null;
  const depth = opts?.depth ?? 0;
  const out: { bucket: Bucket; depth: number; hasChildren: boolean }[] = [];
  for (const bucket of bucketChildren(buckets, parentId)) {
    const hasChildren = bucketChildren(buckets, bucket.id).length > 0;
    out.push({ bucket, depth, hasChildren });
    if (hasChildren && !folded.has(bucket.id)) {
      out.push(...walkBucketTree(buckets, { folded, parentId: bucket.id, depth: depth + 1 }));
    }
  }
  return out;
}

export function bucketDescendantIds(buckets: Bucket[], rootId: string): Set<string> {
  const ids = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    for (const child of bucketChildren(buckets, current)) {
      if (ids.has(child.id)) continue;
      ids.add(child.id);
      stack.push(child.id);
    }
  }
  return ids;
}

export function bucketOptionLabel(bucket: Bucket, depth: number): string {
  return `${"— ".repeat(depth)}${bucket.name}`;
}
