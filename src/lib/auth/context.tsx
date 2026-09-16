import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
export type SignedInUser = {
  id: string
  name: string
  email: string
  role: string
  mustChangePassword: boolean
}
type State = {
  user: SignedInUser | null
  loading: boolean
  error: string
  reload: () => Promise<void>
}
const AccountContext = createContext<State | null>(null)
export async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  actorId?: string,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(actorId ? { 'x-npi-actor': actorId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '操作失败，请刷新核对')
  return data
}
export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SignedInUser | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('')
  const reload = async () => {
    setError('')
    try {
      const response = await fetch('/api/auth/me')
      if (response.status === 401) {
        setUser(null)
        return
      }
      if (!response.ok) throw new Error('无法读取登录状态，请刷新重试')
      setUser((await response.json()).user)
    } catch (e) {
      setError(e instanceof Error ? e.message : '网络连接失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void reload()
  }, [])
  return (
    <AccountContext.Provider value={{ user, loading, error, reload }}>
      {children}
    </AccountContext.Provider>
  )
}
export function useAccount() {
  const state = useContext(AccountContext)
  if (!state) throw new Error('账号上下文未加载')
  return state
}
