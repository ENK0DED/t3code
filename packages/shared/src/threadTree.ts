export const MAX_THREAD_TREE_DEPTH = 1 as const;

export type ThreadTreeDepth = 0 | typeof MAX_THREAD_TREE_DEPTH;

export function getThreadTreeDepth(thread: {
  readonly parentThreadId: string | null;
}): ThreadTreeDepth {
  return thread.parentThreadId === null ? 0 : MAX_THREAD_TREE_DEPTH;
}

export function canThreadCreateChild(thread: { readonly parentThreadId: string | null }): boolean {
  return getThreadTreeDepth(thread) < MAX_THREAD_TREE_DEPTH;
}
