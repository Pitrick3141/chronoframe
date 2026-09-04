export type PhotoSelection = Record<string, boolean>

/** Apply a checkbox action using the current displayed order, not data indexes. */
export function updatePhotoSelection(
  selected: PhotoSelection,
  visibleIds: readonly string[],
  anchorId: string | null,
  targetId: string,
  checked: boolean,
  extendRange = false,
): { selected: PhotoSelection; anchorId: string | null } {
  const targetIndex = visibleIds.indexOf(targetId)
  if (targetIndex < 0) return { selected, anchorId: null }

  const anchorIndex = anchorId === null ? -1 : visibleIds.indexOf(anchorId)
  const useRange = extendRange && anchorIndex >= 0
  const ids = useRange
    ? visibleIds.slice(
        Math.min(anchorIndex, targetIndex),
        Math.max(anchorIndex, targetIndex) + 1,
      )
    : [targetId]
  const next = { ...selected }
  for (const id of ids) {
    if (checked)
      Object.defineProperty(next, id, {
        value: true,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    else delete next[id]
  }

  return { selected: next, anchorId: useRange ? anchorId : targetId }
}
