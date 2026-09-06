import type { PhotoBlur } from '~~/shared/types/photo'

type BlurrablePhoto = { id: string; blur?: PhotoBlur | null }

export function usePhotoBlur() {
  const { t } = useI18n()
  // Shared between gallery and viewer for this visit; a reload hides photos again.
  // Remember the warning too, so an edited warning requires a fresh reveal.
  const revealed = useState<Record<string, string>>(
    'revealed-photo-blurs',
    () => ({}),
  )
  const isPhotoBlurred = (photo: BlurrablePhoto) =>
    !!photo.blur && revealed.value[photo.id] !== JSON.stringify(photo.blur)

  const revealPhoto = (photo: BlurrablePhoto) => {
    if (photo.blur) revealed.value[photo.id] = JSON.stringify(photo.blur)
  }

  const blurLabel = (blur: PhotoBlur) =>
    blur.reason === 'custom'
      ? blur.message
      : t(`photoBlur.reasons.${blur.reason}`)

  return { isPhotoBlurred, revealPhoto, blurLabel }
}
