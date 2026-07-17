export interface NeededExif {
  Title?: string
  XPTitle?: string
  Subject?: string[]
  Keywords?: string[]
  XPKeywords?: string

  Description?: string | string[] | null
  ImageDescription?: string | null
  CaptionAbstract?: string | null
  XPComment?: string | null
  UserComment?: string | null

  zone?: string
  tz?: string
  tzSource?: string

  Orientation?: number
  Make?: string
  Model?: string
  Software?: string
  Artist?: string
  Copyright?: string

  ExposureTime?: string | number
  FNumber?: number
  ExposureProgram?: string
  ISO?: number
  ShutterSpeedValue?: string | number
  ApertureValue?: number
  BrightnessValue?: number
  ExposureCompensation?: number
  MaxApertureValue?: number

  OffsetTime?: string
  OffsetTimeOriginal?: string
  OffsetTimeDigitized?: string

  LightSource?: string
  Flash?: string

  FocalLength?: string
  FocalLengthIn35mmFormat?: string

  LensMake?: string
  LensModel?: string

  ColorSpace?: string

  ExposureMode?: string
  SceneCaptureType?: string

  Aperture?: number
  ScaleFactor35efl?: number
  ShutterSpeed?: string | number
  LightValue?: number

  DateTimeOriginal?: string
  DateTimeDigitized?: string

  ImageWidth?: number
  ImageHeight?: number

  MeteringMode?: string | number | null
  WhiteBalance?: string | number | null
  WBShiftAB?: string | number | null
  WBShiftGM?: string | number | null
  WhiteBalanceBias?: string | number | null
  WhiteBalanceFineTune?: string | number | null
  FlashMeteringMode?: string | number | null
  SensingMethod?: string | number | null
  FocalPlaneXResolution?: number | null
  FocalPlaneYResolution?: number | null
  GPSAltitude?: string | number | null
  GPSLatitude?: string | number | null
  GPSLongitude?: string | number | null
  GPSAltitudeRef?: string | number | null
  GPSLatitudeRef?: string | null
  GPSLongitudeRef?: string | null

  // HDR Type
  MPImageType?: string | string[] | number | null

  Rating?: number

  // Motion Photo (XMP) related fields
  MotionPhoto?: string | number | boolean | null
  MotionPhotoVersion?: string | number | null
  MotionPhotoPresentationTimestampUs?: string | number | null
  MicroVideo?: string | number | boolean | null
  MicroVideoVersion?: string | number | null
  MicroVideoOffset?: string | number | null
  MicroVideoPresentationTimestampUs?: string | number | null
}

export interface PhotoInfo {
  title: string
  dateTaken: string
  tags: string[]
  description: string
}
