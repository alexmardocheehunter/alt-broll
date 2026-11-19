/** Exécute `task` sur chaque élément, au plus `limit` à la fois ; rejette à la première erreur. */
export async function forEachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await task(item);
    }
  });
  await Promise.all(lanes);
}
