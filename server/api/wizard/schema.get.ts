import { z } from 'zod'
import { settingsManager } from '~~/server/services/settings/settingsManager'
import { getSettingUIConfig } from '~~/server/services/settings/ui-config'
import type { FieldDescriptor } from '~~/shared/types/settings'

const WIZARD_NAMESPACES = ['admin', 'site', 'map', 'storage'] as const

function redactSecretField<T extends FieldDescriptor>(field: T) {
  if (!field.isSecret) return field

  const { value, defaultValue, ...safeField } = field
  const configuredValue = value ?? defaultValue

  return {
    ...safeField,
    hasValue:
      configuredValue !== null &&
      configuredValue !== undefined &&
      configuredValue !== '',
  }
}

export default eventHandler(async (event) => {
  const query = await getValidatedQuery(
    event,
    z.object({
      namespace: z.enum(WIZARD_NAMESPACES),
    }).parse,
  )

  // 1. Admin Account Schema
  if (query.namespace === 'admin') {
    const fields: FieldDescriptor[] = [
      {
        namespace: 'admin',
        key: 'username',
        type: 'string',
        defaultValue: 'admin',
        value: 'admin',
        label: 'wizard.admin.username.label',
        ui: { type: 'input', required: true, placeholder: 'admin' },
      },
      {
        namespace: 'admin',
        key: 'email',
        type: 'string',
        defaultValue: '',
        value: '',
        label: 'wizard.admin.email.label',
        ui: { type: 'input', required: true, placeholder: 'admin@example.com' },
      },
      {
        namespace: 'admin',
        key: 'password',
        type: 'string',
        isSecret: true,
        hasValue: false,
        label: 'wizard.admin.password.label',
        ui: { type: 'password', required: true },
      },
      {
        namespace: 'admin',
        key: 'confirmPassword',
        type: 'string',
        isSecret: true,
        hasValue: false,
        label: 'wizard.admin.confirmPassword.label',
        ui: { type: 'password', required: true },
      },
    ] satisfies FieldDescriptor[]

    return { namespace: 'admin', fields }
  }

  // 2. Storage Schema (Custom for Wizard)
  if (query.namespace === 'storage') {
    // D1, Hosted Images and R2 are deployment bindings, not editable settings.
    return { namespace: 'storage', fields: [] satisfies FieldDescriptor[] }
  }

  // 3. App & Map Schemas (From Settings Manager)
  try {
    const settingsNamespace = query.namespace === 'site' ? 'app' : 'map'
    const schema = await settingsManager.getSchema()
    const namespaceSettings = schema.filter(
      (s) => s.namespace === settingsNamespace,
    )

    const fields = namespaceSettings.map((setting) => {
      const uiConfig = getSettingUIConfig(settingsNamespace, setting.key)

      // Patch for Wizard Map Provider to use rich selector
      if (settingsNamespace === 'map' && setting.key === 'provider') {
        return redactSecretField({
          ...setting,
          ui: {
            type: 'custom',
            options: [
              {
                label: 'wizard.map.provider.mapbox.label',
                value: 'mapbox',
                icon: 'simple-icons:mapbox',
                description: 'wizard.map.provider.mapbox.description',
              },
              {
                label: 'wizard.map.provider.maplibre.label',
                value: 'maplibre',
                icon: 'simple-icons:maplibre',
                description: 'wizard.map.provider.maplibre.description',
              },
            ],
          },
        })
      }

      return redactSecretField({
        ...setting,
        ui: uiConfig || {
          type: 'input' as const,
          required: false,
        },
      })
    })

    return {
      namespace: query.namespace,
      fields,
    }
  } catch {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch wizard schema',
    })
  }
})
