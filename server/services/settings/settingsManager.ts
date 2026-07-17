import type {
  NewSettingStorageProvider,
  SettingConfig,
  SettingStorageProvider,
  SettingType,
  SettingValue,
} from '~~/shared/types/settings'
import type { SettingKey, SettingNamespace } from './contants'

export class SettingsManager {
  private static instance: SettingsManager
  protected _logger = logger.dynamic('settings-mgr')
  private initialized = false

  private constructor() {}

  static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager()
    }
    return SettingsManager.instance
  }

  /**
   * Validate setting value against enum if defined
   * @param value Setting value
   * @param enumValues Enum values if defined
   * @returns true if valid, false if not valid
   */
  private validateEnum(
    value: SettingValue,
    enumValues: string[] | null,
  ): boolean {
    // Allow null values if no enum is defined
    if (value === null) {
      return !enumValues || enumValues.length === 0
    }

    if (!enumValues || enumValues.length === 0) {
      return true
    }
    return enumValues.includes(String(value))
  }

  /**
   * Generate cache key for a setting
   * @param namespace
   * @param key
   * @returns Cache key string
   * @example
   * getCacheKey('app', 'theme') => 'app:theme'
   */
  private getCacheKey(
    namespace: SettingNamespace,
    key: SettingKey<typeof namespace>,
  ): string {
    return `${namespace}:${key}`
  }

  /**
   * Serialize setting value to string for storage
   * @param value Setting value
   * @returns Serialized string
   * @example
   * serialize(true) => 'true'
   * serialize({ theme: 'dark' }) => '{"theme":"dark"}'
   * serialize(null) => 'null'
   */
  private serialize(value: SettingValue): string | null {
    if (value === null) return null
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  }

  /**
   * Deserialize setting value from string
   * @param value Serialized string or null
   * @param type Setting type
   * @returns Deserialized setting value
   * @example
   * deserialize('true', 'boolean') => true
   * deserialize('{"theme":"dark"}', 'json') => { theme: 'dark' }
   * deserialize('null', 'string') => null
   * deserialize(null, 'string') => null
   */
  private deserialize(value: string | null, type: SettingType): SettingValue {
    // Handle null or 'null' string value
    if (value === null || value === 'null') {
      return null
    }

    switch (type) {
      case 'string':
        return value
      case 'number':
        return Number(value)
      case 'boolean':
        return value === 'true'
      default:
        return JSON.parse(value)
    }
  }

  /**
   * Initialize settings manager with default settings
   * @param configs Array of setting configurations
   */
  async init(configs: SettingConfig[]): Promise<void> {
    if (this.initialized) return

    // Do not cache an in-flight D1 promise in isolate-global state. Concurrent
    // cold-start requests may each run this idempotent insert, but every D1
    // operation then remains owned by the request that created it.
    await this.initialize(configs)
    this.initialized = true
  }

  private async initialize(configs: SettingConfig[]): Promise<void> {
    const db = useDB()

    this._logger.info('Initializing settings manager with default settings')

    const values = configs.flatMap((config) => {
      if (!config.namespace || !config.key) {
        this._logger.warn('Skipping config with missing namespace or key')
        return []
      }

      return [
        {
          namespace: config.namespace,
          key: config.key,
          type: config.type,
          value: this.serialize(config.defaultValue),
          defaultValue: this.serialize(config.defaultValue),
          label: config.label ?? null,
          description: config.description ?? null,
          isPublic: config.isPublic ?? false,
          isReadonly: config.isReadonly ?? false,
          isSecret: config.isSecret ?? false,
          enum: config.enum ? [...config.enum] : null,
        },
      ]
    })

    // Keep each statement below D1's conservative bind-parameter ceiling.
    const rowsPerStatement = 8
    for (let offset = 0; offset < values.length; offset += rowsPerStatement) {
      await db
        .insert(tables.settings)
        .values(values.slice(offset, offset + rowsPerStatement))
        .onConflictDoNothing({
          target: [tables.settings.namespace, tables.settings.key],
        })
        .run()
    }
  }

  async get<T = SettingValue>(
    namespace: SettingNamespace,
    key: SettingKey<typeof namespace>,
    defaultValue?: T,
  ): Promise<T | null> {
    const cacheKey = this.getCacheKey(namespace, key)

    // Read through D1 so settings changed by another Worker isolate stay fresh.
    const db = useDB()
    const setting = await db
      .select()
      .from(tables.settings)
      .where(
        and(
          eq(tables.settings.namespace, namespace),
          eq(tables.settings.key, key),
        ),
      )
      .get()

    // If not found, return default value
    if (!setting) {
      this._logger.debug(
        `Setting ${cacheKey} not found, returning default value`,
      )
      return defaultValue ?? null
    }

    this._logger.debug(`Setting ${cacheKey} fetched from database`)
    const value = this.deserialize(setting.value, setting.type)

    return value as T
  }

  async set(
    namespace: SettingNamespace,
    key: SettingKey<typeof namespace>,
    value: SettingValue,
    updatedBy?: number,
    sudo = false,
  ): Promise<void> {
    const db = useDB()

    const existing = await db
      .select()
      .from(tables.settings)
      .where(
        and(
          eq(tables.settings.namespace, namespace),
          eq(tables.settings.key, key),
        ),
      )
      .get()

    if (!existing) {
      this._logger.warn(`Setting ${namespace}:${key} does not exist`)
      throw new Error(`Setting ${namespace}:${key} does not exist`)
    }

    if (existing.isReadonly && !sudo) {
      this._logger.warn(
        `Attempt to modify readonly setting ${namespace}:${key}`,
      )
      throw new Error(`Setting ${namespace}:${key} is readonly`)
    }

    if (!this.validateEnum(value, existing.enum)) {
      this._logger.warn(
        `Invalid value for enum setting ${namespace}:${key}. Value: ${value}, allowed: ${existing.enum?.join(', ')}`,
      )
      throw new Error(
        `Invalid value for setting ${namespace}:${key}. Allowed values: ${existing.enum?.join(', ')}`,
      )
    }

    const serializedValue = this.serialize(value)

    await db
      .update(tables.settings)
      .set({
        value: serializedValue,
        updatedAt: new Date(),
        updatedBy: updatedBy ?? null,
      })
      .where(
        and(
          eq(tables.settings.namespace, namespace),
          eq(tables.settings.key, key),
        ),
      )
      .run()

    this._logger.info(`Setting ${namespace}:${key} updated`)
  }

  async getNamespace(
    namespace: SettingNamespace,
  ): Promise<Record<string, SettingValue>> {
    const db = useDB()
    const settings = await db
      .select()
      .from(tables.settings)
      .where(eq(tables.settings.namespace, namespace))
      .all()

    const result: Record<string, SettingValue> = {}

    for (const setting of settings) {
      result[setting.key] = this.deserialize(setting.value, setting.type)
    }
    return result
  }

  async getSchema(): Promise<SettingConfig[]> {
    const db = useDB()
    const settings = await db.select().from(tables.settings).all()

    return settings.map((setting) => ({
      namespace: setting.namespace,
      key: setting.key,
      type: setting.type,
      value: this.deserialize(setting.value, setting.type),
      defaultValue:
        setting.defaultValue &&
        this.deserialize(setting.defaultValue, setting.type),
      label: setting.label,
      description: setting.description,
      isReadonly: setting.isReadonly,
      isSecret: setting.isSecret,
      // 包含枚举值，过滤掉 null
      ...(setting.enum ? { enum: setting.enum } : {}),
    }))
  }

  // Storage Providers Management
  public storage = {
    async getProviders(): Promise<SettingStorageProvider[]> {
      const db = useDB()
      const providers = await db
        .select()
        .from(tables.settings_storage_providers)
        .all()
      return providers
    },

    async getProviderById(id: number): Promise<SettingStorageProvider | null> {
      const db = useDB()
      const provider = await db
        .select()
        .from(tables.settings_storage_providers)
        .where(eq(tables.settings_storage_providers.id, id))
        .get()
      return provider || null
    },

    async getActiveProvider(): Promise<SettingStorageProvider | null> {
      const providerId = await settingsManager.get<number>(
        'storage',
        'provider',
      )
      if (!providerId) {
        return null
      }
      return this.getProviderById(providerId)
    },

    async addProvider(
      providerConfig: NewSettingStorageProvider,
    ): Promise<number> {
      const db = useDB()
      const result = await db
        .insert(tables.settings_storage_providers)
        .values({
          name: providerConfig.name,
          provider: providerConfig.provider,
          config: providerConfig.config,
        })
        .returning({ id: tables.settings_storage_providers.id })
        .get()

      if (!result) {
        throw new Error('Failed to create storage provider')
      }

      // If no active provider and this is the only provider, set this as active
      const currentActiveProvider = await settingsManager.get<number>(
        'storage',
        'provider',
      )
      if (!currentActiveProvider && (await this.getProviders()).length === 1) {
        await settingsManager.set('storage', 'provider', result.id)
      }
      return result.id
    },

    async updateProvider(
      id: number,
      providerConfig: Partial<NewSettingStorageProvider['config']>,
    ): Promise<void> {
      const db = useDB()
      await db
        .update(tables.settings_storage_providers)
        .set({
          ...providerConfig,
        })
        .where(eq(tables.settings_storage_providers.id, id))
        .run()
    },

    async deleteProvider(id: number): Promise<void> {
      const db = useDB()
      await db
        .delete(tables.settings_storage_providers)
        .where(eq(tables.settings_storage_providers.id, id))
        .run()
    },
  }
}

export const settingsManager = SettingsManager.getInstance()
