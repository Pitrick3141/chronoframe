export const testLivePhotoDetection = async (_imageKey: string) => ({
  found: false,
})

export const batchTestLivePhotoDetection = async (photoIds?: string[]) => ({
  total: photoIds?.length ?? 0,
  processed: 0,
  found: 0,
  results: [],
})
