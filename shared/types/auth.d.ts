import type { User as DBUser } from '../../server/utils/db'

export type PublicSessionUser = Pick<
  DBUser,
  'id' | 'username' | 'email' | 'avatar' | 'createdAt' | 'isAdmin'
>

declare module '#auth-utils' {
  interface User extends PublicSessionUser {}
}
