export const scanAndProcessExistingLivePhotos = async (): Promise<{
  processed: number
  matched: number
  errors: string[]
}> => ({
  processed: 0,
  matched: 0,
  errors: [
    'Legacy storage scanning is unavailable on Workers. Live Photo videos are associated during upload.',
  ],
})

export const processSpecificLivePhotoVideo = async (
  _videoKey: string,
): Promise<boolean> => false
