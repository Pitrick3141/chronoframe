import type { StorageConfig } from '../../../shared/types/storage'
import type { Logger } from '../../utils/logger'
import type {
  StorageObject,
  StorageProvider,
  UploadOptions,
} from './interfaces'

export type StorageManagerEventType = 'provider-changed' | 'provider-error'

export interface StorageManagerEventListener {
  (event: StorageManagerEvent): void | Promise<void>
}

export interface StorageManagerEvent {
  type: StorageManagerEventType
  provider?: string
  oldProvider?: string
  error?: Error
  timestamp: number
}

class LegacyProviderDisabled implements StorageProvider {
  constructor(public readonly config: StorageConfig) {}

  private unavailable(): never {
    throw new Error(
      'Legacy local/S3/OpenList providers are disabled. Use the MEDIA_BUCKET R2 binding.',
    )
  }

  async create(
    _key: string,
    _fileBuffer: Uint8Array | ArrayBuffer,
    _contentType?: string,
  ): Promise<StorageObject> {
    return this.unavailable()
  }

  async delete(_key: string): Promise<void> {
    return this.unavailable()
  }

  async get(_key: string): Promise<Uint8Array | null> {
    return this.unavailable()
  }

  getPublicUrl(key: string): string {
    return `/storage/${key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')}`
  }

  async getSignedUrl(
    _key: string,
    _expiresIn?: number,
    _options?: UploadOptions,
  ): Promise<string> {
    return this.unavailable()
  }

  async getFileMeta(_key: string): Promise<StorageObject | null> {
    return this.unavailable()
  }

  async listAll(): Promise<StorageObject[]> {
    return this.unavailable()
  }

  async listImages(): Promise<StorageObject[]> {
    return this.unavailable()
  }
}

export class StorageProviderFactory {
  static createProvider(
    config: StorageConfig,
    _logger?: Logger['storage'],
  ): StorageProvider {
    return new LegacyProviderDisabled(config)
  }
}

export class StorageManager {
  private provider: StorageProvider
  private currentProviderName?: string

  constructor(
    config: StorageConfig,
    private readonly log?: Logger['storage'],
  ) {
    this.currentProviderName = config.provider
    this.provider = StorageProviderFactory.createProvider(config, log)
  }

  on(
    _eventType: StorageManagerEventType,
    _listener: StorageManagerEventListener,
  ): void {}

  off(
    _eventType: StorageManagerEventType,
    _listener: StorageManagerEventListener,
  ): void {}

  async registerProvider(
    config: StorageConfig,
    logger?: Logger['storage'],
  ): Promise<void> {
    this.log?.warn(
      `Ignoring legacy storage provider switch to ${config.provider}; R2 is binding-managed.`,
    )
    this.provider = StorageProviderFactory.createProvider(config, logger)
    this.currentProviderName = config.provider
  }

  getProvider<T extends StorageProvider>(): T {
    return this.provider as T
  }

  getCurrentProviderName(): string | undefined {
    return this.currentProviderName
  }
}
