export interface UploadProgress {
  loaded: number
  total: number
  percentage: number
  speed?: number // bytes per second
  timeRemaining?: number // seconds
}

export interface UploadStatus {
  status: 'idle' | 'uploading' | 'success' | 'error' | 'aborted'
  progress: UploadProgress
  error?: string
  startTime?: number
  endTime?: number
}

export interface UploadCallbacks {
  onProgress?: (progress: UploadProgress) => void
  onStatusChange?: (status: UploadStatus['status']) => void
  onSuccess?: (response: XMLHttpRequest) => void | Promise<void>
  onError?: (error: string, xhr: XMLHttpRequest) => void
  onAbort?: () => void
  onRetry?: (attempt: number, maxAttempts: number) => void
}

export interface UseUploadOptions {
  timeout?: number // 超时时间（毫秒）
  withCredentials?: boolean
  headers?: Record<string, string>
  speedSampleSize?: number // 用于计算速度的样本数量
  maxRetries?: number // 最大重试次数
  retryDelay?: number // 重试延迟（毫秒）
}

export interface UploadTransportOptions {
  method?: 'PUT' | 'POST'
  encoding?: 'raw' | 'multipart'
  fileFieldName?: string
  /** Per-call automatic retry count. Set to 0 for one-time upload URLs. */
  maxRetries?: number
}

export function useUpload(options: UseUploadOptions = {}) {
  // useUpload() is invoked from within an async upload handler (outside the
  // synchronous setup context), so useI18n() would throw "Must be called at
  // the top of a `setup` function". Use the Nuxt-global i18n instead, which is
  // safe to access outside setup (see useExifLocalization).
  const { $i18n } = useNuxtApp()
  const t = $i18n.t
  const {
    timeout = 0,
    withCredentials = false,
    headers = {},
    speedSampleSize = 5,
    maxRetries = 3,
    retryDelay = 1000,
  } = options

  // 响应式状态
  const uploadStatus = ref<UploadStatus>({
    status: 'idle',
    progress: {
      loaded: 0,
      total: 0,
      percentage: 0,
    },
  })

  // 当前的 XMLHttpRequest 实例
  let currentXHR: XMLHttpRequest | null = null

  interface UploadOperation {
    generation: number
    callbacks: UploadCallbacks
    cancelled: boolean
    completed: boolean
    abortNotified: boolean
    retryTimer: ReturnType<typeof setTimeout> | null
    reject: ((reason?: unknown) => void) | null
  }

  let uploadGeneration = 0
  let activeOperation: UploadOperation | null = null

  // 用于计算速度的数据点
  const speedSamples: Array<{ timestamp: number; loaded: number }> = []

  // 计算上传速度和剩余时间
  const calculateSpeed = (
    loaded: number,
  ): { speed: number; timeRemaining?: number } => {
    const now = Date.now()
    speedSamples.push({ timestamp: now, loaded })

    // 保持样本数量在限制内
    if (speedSamples.length > speedSampleSize) {
      speedSamples.shift()
    }

    if (speedSamples.length < 2) {
      return { speed: 0 }
    }

    // 计算平均速度
    const firstSample = speedSamples[0]
    const lastSample = speedSamples[speedSamples.length - 1]

    if (!firstSample || !lastSample) {
      return { speed: 0 }
    }

    const timeDiff = (lastSample.timestamp - firstSample.timestamp) / 1000 // 转换为秒
    const bytesDiff = lastSample.loaded - firstSample.loaded

    const speed = timeDiff > 0 ? bytesDiff / timeDiff : 0

    // 计算剩余时间
    const total = uploadStatus.value.progress.total
    const remaining = total - loaded
    const timeRemaining = speed > 0 ? remaining / speed : undefined

    return { speed, timeRemaining }
  }

  // 更新状态
  const updateStatus = (updates: Partial<UploadStatus>) => {
    uploadStatus.value = { ...uploadStatus.value, ...updates }
  }

  // 更新进度
  const updateProgress = (loaded: number, total: number) => {
    const percentage = total > 0 ? Math.round((loaded / total) * 100) : 0
    const { speed, timeRemaining } = calculateSpeed(loaded)

    const progress: UploadProgress = {
      loaded,
      total,
      percentage,
      speed,
      timeRemaining,
    }

    updateStatus({ progress })
  }

  // 重置状态
  const resetStatus = () => {
    speedSamples.length = 0
    updateStatus({
      status: 'idle',
      progress: {
        loaded: 0,
        total: 0,
        percentage: 0,
      },
      error: undefined,
      startTime: undefined,
      endTime: undefined,
    })
  }

  // 主要的上传函数
  const uploadFileAttempt = async (
    file: File,
    signedUrl: string,
    callbacks: UploadCallbacks,
    transportOptions: UploadTransportOptions,
    attempt: number,
    operation: UploadOperation,
  ): Promise<XMLHttpRequest> => {
    // Preserve the historical default (maxRetries is the total attempt count)
    // while allowing an individual one-time upload URL to explicitly disable
    // retries with transportOptions.maxRetries = 0.
    const maxAttempts =
      transportOptions.maxRetries === undefined
        ? maxRetries
        : Math.max(1, transportOptions.maxRetries + 1)

    if (
      operation.cancelled ||
      operation.completed ||
      activeOperation?.generation !== operation.generation
    ) {
      throw new Error(t('upload.runtimeError.aborted'))
    }

    // 第一次上传重置全部状态；每次重试都必须清空速度样本和旧进度。
    if (attempt === 1) {
      resetStatus()
    }
    speedSamples.length = 0
    updateStatus({
      progress: {
        loaded: 0,
        total: file.size,
        percentage: 0,
      },
      error: undefined,
      endTime: undefined,
    })

    return new Promise((resolve, reject) => {
      operation.reject = reject

      if (
        operation.cancelled ||
        activeOperation?.generation !== operation.generation
      ) {
        reject(new Error(t('upload.runtimeError.aborted')))
        return
      }

      // 创建新的 XHR 实例
      currentXHR = new XMLHttpRequest()
      const xhr = currentXHR
      let settled = false
      const isCurrentOperation = () =>
        !operation.cancelled &&
        activeOperation?.generation === operation.generation

      const getResponseData = (): any | undefined => {
        try {
          return xhr.responseText ? JSON.parse(xhr.responseText) : undefined
        } catch {
          return undefined
        }
      }

      const getErrorMessage = () => {
        let errorMessage = ''

        switch (xhr.status) {
          case 0:
            errorMessage = t('upload.runtimeError.networkFailed')
            break
          case 400:
            errorMessage = t('upload.runtimeError.badRequest')
            break
          case 401:
            errorMessage = t('upload.runtimeError.unauthorized')
            break
          case 403:
            errorMessage = t('upload.runtimeError.forbidden')
            break
          case 404:
            errorMessage = t('upload.runtimeError.notFound')
            break
          case 409:
            errorMessage = t('upload.runtimeError.conflict')
            break
          case 413:
            errorMessage = t('upload.runtimeError.fileTooLarge')
            break
          case 415:
            errorMessage = t('upload.runtimeError.unsupportedType')
            break
          case 429:
            errorMessage = t('upload.runtimeError.rateLimited')
            break
          case 500:
            errorMessage = t('upload.runtimeError.internalServerError')
            break
          case 502:
          case 503:
          case 504:
            errorMessage = t('upload.runtimeError.serviceUnavailable')
            break
          default:
            if (xhr.status >= 400 && xhr.status < 500) {
              errorMessage = t('upload.runtimeError.clientError', {
                status: xhr.status,
              })
            } else if (xhr.status >= 500) {
              errorMessage = t('upload.runtimeError.serverError', {
                status: xhr.status,
              })
            } else {
              errorMessage = t('upload.runtimeError.httpError', {
                status: xhr.status,
              })
            }
        }

        // Prefer a structured error returned by the Worker when available.
        const responseData = getResponseData()
        const serverMessage =
          responseData?.data?.message ||
          responseData?.statusMessage ||
          responseData?.message
        if (typeof serverMessage === 'string' && serverMessage) {
          errorMessage = serverMessage
        }

        return errorMessage
      }

      const failOrRetry = (errorMessage: string, canRetry: boolean) => {
        if (settled) return
        if (!isCurrentOperation()) {
          settled = true
          reject(new Error(t('upload.runtimeError.aborted')))
          return
        }
        settled = true

        const endTime = Date.now()
        if (canRetry) {
          updateStatus({
            status: 'error',
            error: t('upload.runtimeError.retrying', {
              message: errorMessage,
              attempt,
              max: maxAttempts,
            }),
            endTime,
          })
          callbacks.onRetry?.(attempt, maxAttempts)

          operation.retryTimer = setTimeout(() => {
            operation.retryTimer = null
            if (
              operation.cancelled ||
              activeOperation?.generation !== operation.generation
            ) {
              reject(new Error(t('upload.runtimeError.aborted')))
              return
            }

            uploadFileAttempt(
              file,
              signedUrl,
              callbacks,
              transportOptions,
              attempt + 1,
              operation,
            )
              .then(resolve)
              .catch(reject)
          }, retryDelay * attempt)
          return
        }

        updateStatus({ status: 'error', error: errorMessage, endTime })
        callbacks.onStatusChange?.('error')
        callbacks.onError?.(errorMessage, xhr)
        const error = new Error(errorMessage) as Error & {
          status: number
          statusCode: number
          response: { status: number }
          data?: any
        }
        error.status = xhr.status
        error.statusCode = xhr.status
        error.response = { status: xhr.status }
        const responseData = getResponseData()
        error.data = responseData?.data ?? responseData
        reject(error)
      }

      // 设置超时
      if (timeout > 0) {
        xhr.timeout = timeout
      }

      // 设置是否携带凭证
      xhr.withCredentials = withCredentials

      // 记录开始时间
      const startTime = Date.now()
      updateStatus({ status: 'uploading', startTime })
      callbacks.onStatusChange?.('uploading')

      // 进度事件处理
      xhr.upload.addEventListener('progress', (event) => {
        if (isCurrentOperation() && event.lengthComputable) {
          updateProgress(event.loaded, event.total)
          callbacks.onProgress?.(uploadStatus.value.progress)
        }
      })

      // load 会在 HTTP 4xx/5xx 时触发，因此必须显式检查状态码。
      xhr.addEventListener('load', async () => {
        if (!isCurrentOperation()) {
          if (!settled) {
            settled = true
            reject(new Error(t('upload.runtimeError.aborted')))
          }
          return
        }

        if (xhr.status < 200 || xhr.status >= 300) {
          failOrRetry(
            getErrorMessage(),
            attempt < maxAttempts &&
              (xhr.status === 0 || xhr.status === 429 || xhr.status >= 500),
          )
          return
        }

        if (settled) return
        settled = true
        const endTime = Date.now()
        updateStatus({ status: 'success', endTime })
        callbacks.onStatusChange?.('success')
        try {
          await callbacks.onSuccess?.(xhr)
          resolve(xhr)
        } catch (error) {
          reject(error)
        }
      })

      // 错误处理
      xhr.addEventListener('error', () => {
        failOrRetry(
          getErrorMessage(),
          attempt < maxAttempts &&
            (xhr.status === 0 || xhr.status === 429 || xhr.status >= 500),
        )
      })

      // 超时处理
      xhr.addEventListener('timeout', () => {
        const errorMessage = t('upload.runtimeError.timeout', { timeout })
        failOrRetry(errorMessage, attempt < maxAttempts)
      })

      // 中止处理
      xhr.addEventListener('abort', () => {
        if (settled) return
        settled = true
        const endTime = Date.now()
        if (activeOperation?.generation === operation.generation) {
          updateStatus({ status: 'aborted', endTime })
        }
        if (!operation.abortNotified) {
          operation.abortNotified = true
          callbacks.onStatusChange?.('aborted')
          callbacks.onAbort?.()
        }
        reject(new Error(t('upload.runtimeError.aborted')))
      })

      const uploadMethod = transportOptions.method ?? 'PUT'
      const uploadEncoding = transportOptions.encoding ?? 'raw'
      const fileFieldName = transportOptions.fileFieldName?.trim() || 'file'

      // 准备请求。Cloudflare Stream direct upload uses multipart POST;
      // Hosted Images/R2 keep the existing raw PUT transport.
      xhr.open(uploadMethod, signedUrl)

      if (uploadEncoding === 'raw') {
        xhr.setRequestHeader(
          'Content-Type',
          file.type || 'application/octet-stream',
        )
      }

      // 设置自定义请求头
      Object.entries(headers).forEach(([key, value]) => {
        // The browser must add the multipart boundary itself.
        if (
          uploadEncoding === 'multipart' &&
          key.toLowerCase() === 'content-type'
        ) {
          return
        }
        xhr.setRequestHeader(key, value)
      })

      // 开始上传
      if (uploadEncoding === 'multipart') {
        const body = new FormData()
        body.append(fileFieldName, file, file.name)
        xhr.send(body)
      } else {
        xhr.send(file)
      }
    })
  }

  const uploadFile = (
    file: File,
    signedUrl: string,
    callbacks: UploadCallbacks = {},
    transportOptions: UploadTransportOptions = {},
  ): Promise<XMLHttpRequest> => {
    if (activeOperation && !activeOperation.completed) {
      abortUpload()
    }

    const operation: UploadOperation = {
      generation: ++uploadGeneration,
      callbacks,
      cancelled: false,
      completed: false,
      abortNotified: false,
      retryTimer: null,
      reject: null,
    }
    activeOperation = operation

    return uploadFileAttempt(
      file,
      signedUrl,
      callbacks,
      transportOptions,
      1,
      operation,
    ).finally(() => {
      operation.completed = true
      if (operation.retryTimer) {
        clearTimeout(operation.retryTimer)
        operation.retryTimer = null
      }
      operation.reject = null
      if (activeOperation?.generation === operation.generation) {
        activeOperation = null
        currentXHR = null
      }
    })
  }

  // 中止上传
  const abortUpload = () => {
    const operation = activeOperation
    if (!operation || operation.cancelled || operation.completed) return

    operation.cancelled = true
    if (operation.retryTimer) {
      clearTimeout(operation.retryTimer)
      operation.retryTimer = null
    }

    const abortError = new Error(t('upload.runtimeError.aborted'))
    if (!operation.abortNotified) {
      operation.abortNotified = true
      updateStatus({ status: 'aborted', endTime: Date.now() })
      operation.callbacks.onStatusChange?.('aborted')
      operation.callbacks.onAbort?.()
    }

    const xhr = currentXHR
    if (xhr && xhr.readyState !== XMLHttpRequest.DONE) {
      xhr.abort()
    }
    operation.reject?.(abortError)
  }

  // 格式化字节大小
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  // 格式化时间
  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds) || seconds < 0)
      return t('upload.progress.calculating')

    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    } else if (minutes > 0) {
      return `${minutes}:${secs.toString().padStart(2, '0')}`
    } else {
      return t('upload.progress.seconds', { seconds: secs })
    }
  }

  // 计算属性
  const isUploading = computed(() => uploadStatus.value.status === 'uploading')
  const isIdle = computed(() => uploadStatus.value.status === 'idle')
  const isSuccess = computed(() => uploadStatus.value.status === 'success')
  const isError = computed(() => uploadStatus.value.status === 'error')
  const isAborted = computed(() => uploadStatus.value.status === 'aborted')
  const canAbort = computed(() => isUploading.value && currentXHR !== null)

  // 格式化的进度信息
  const formattedProgress = computed(() => {
    const { loaded, total, percentage, speed, timeRemaining } =
      uploadStatus.value.progress
    return {
      percentage,
      loadedText: formatBytes(loaded),
      totalText: formatBytes(total),
      speedText: speed ? `${formatBytes(speed)}/s` : '',
      timeRemainingText: timeRemaining ? formatTime(timeRemaining) : '',
      progressText: `${formatBytes(loaded)} / ${formatBytes(total)} (${percentage}%)`,
    }
  })

  // 清理函数（仅在组件上下文中可用）
  try {
    onUnmounted(() => {
      abortUpload()
      currentXHR = null
    })
  } catch {
    /* empty */
  }

  return {
    uploadStatus: readonly(uploadStatus),

    isUploading,
    isIdle,
    isSuccess,
    isError,
    isAborted,
    canAbort,
    formattedProgress,

    uploadFile,
    abortUpload,
    resetStatus,
    formatBytes,
    formatTime,
  }
}
