import { requireCloudflareBinding } from './cloudflare-bindings'
import type { User } from './db'

interface InitialAdminInput {
  email: string
  passwordHash: string
  username: string
}

interface InitialAdminRow {
  avatar: string | null
  created_at: number
  email: string
  id: number
  is_admin: number
  name: string
  password: string | null
}

/**
 * Atomically claim an empty installation for its first administrator.
 *
 * D1 serializes this single statement, so two bootstrap requests cannot both
 * observe an empty users table and insert separate administrators.
 */
export async function createInitialAdminAtomically(
  input: InitialAdminInput,
): Promise<User | null> {
  const createdAt = Math.floor(Date.now() / 1000)
  const row = await requireCloudflareBinding('DB')
    .prepare(
      `INSERT INTO users (name, email, password, avatar, created_at, is_admin)
       SELECT ?, ?, ?, NULL, ?, 1
       WHERE NOT EXISTS (SELECT 1 FROM users)
       RETURNING id, name, email, password, avatar, created_at, is_admin`,
    )
    .bind(input.username, input.email, input.passwordHash, createdAt)
    .first<InitialAdminRow>()

  if (!row) return null

  return {
    id: row.id,
    username: row.name,
    email: row.email,
    password: row.password,
    avatar: row.avatar,
    createdAt: new Date(row.created_at * 1000),
    isAdmin: row.is_admin,
  }
}
