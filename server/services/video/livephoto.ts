const extensionOf = (fileName: string): string => {
  const normalized = fileName.split(/[?#]/, 1)[0]?.toLowerCase() ?? ''
  const index = normalized.lastIndexOf('.')
  return index >= 0 ? normalized.slice(index) : ''
}

export const processLivePhotoVideo = async (
  _videoKey: string,
  _videoSize: number,
): Promise<boolean> => false

export const findLivePhotoVideoForImage = async (
  _imageKey: string,
): Promise<{ videoKey: string; videoSize: number } | null> => null

export const isVideoFile = (fileName: string): boolean =>
  ['.mov', '.mp4'].includes(extensionOf(fileName))

export const isLivePhotoVideo = (fileName: string, fileSize: number): boolean =>
  extensionOf(fileName) === '.mov' && fileSize <= 12 * 1024 * 1024
