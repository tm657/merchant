export function TableSkeleton({ rows = 8, withFilterBar = false }: { rows?: number; withFilterBar?: boolean }) {
  return (
    <div role="status" aria-label="Loading transactions" className="flex flex-col gap-3">
      {withFilterBar && <div className="h-14 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-900" />}
      <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="h-9 bg-zinc-50 dark:bg-zinc-900" />
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex gap-4 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div className="h-4 w-1/4 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="ml-auto h-4 w-20 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
