import { useEffect, useState } from 'react'
// This alias and main.tsx's relative import intentionally resolve to one module.
import { request, useAccount } from '@/lib/auth/context'
import { NpiWorkspace } from './components/npi/NpiWorkspace'
import { AccountManager } from './components/accounts/AccountManager'
import type { FormEvent } from 'react'

function Login() {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const f = new FormData(e.currentTarget)
    try {
      await request('/api/auth/login', 'POST', {
        email: f.get('email'),
        password: f.get('password'),
      })
      location.assign('/npi')
    } catch (error) {
      setError(error instanceof Error ? error.message : '登录失败')
      setBusy(false)
    }
  }
  return (
    <div className="login-page">
      <div className="login-intro">
        <span className="wordmark">新品协同</span>
        <h1>
          让新品交付
          <br />
          有计划、有回应。
        </h1>
        <p>项目 · BOM · 制造准备 · 采购协作</p>
        <div className="login-line" />
        <p>
          从要求日期到实际完成，
          <br />
          每一次承诺与变化都有据可查。
        </p>
      </div>
      <main className="login-card">
        <p className="eyebrow">NPI WORKSPACE</p>
        <h2>登录工作空间</h2>
        <p className="muted">使用管理员为你开通的账号</p>
        <form onSubmit={(e) => void submit(e)}>
          <fieldset disabled={busy}>
            <label>
              邮箱
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                maxLength={254}
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </label>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <button className="primary" type="submit">
              {busy ? '正在登录…' : '登录'}
            </button>
          </fieldset>
        </form>
        <p className="muted small">忘记密码请联系本系统管理员重置。</p>
      </main>
    </div>
  )
}
function AccountPage() {
  const { user, reload } = useAccount(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  useEffect(() => {
    if (user?.mustChangePassword && location.pathname !== '/account')
      history.replaceState(null, '', '/account')
  }, [user?.mustChangePassword])
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget,
      f = new FormData(form)
    setError('')
    setNotice('')
    if (f.get('password') !== f.get('confirm')) {
      setError('两次输入的新密码不一致')
      return
    }
    setBusy(true)
    try {
      await request(
        '/api/auth/password',
        'POST',
        { oldPassword: f.get('oldPassword'), password: f.get('password') },
        user!.id,
      )
      form.reset()
      await reload()
      setNotice('密码已修改，其他设备的登录已退出。')
    } catch (error) {
      setError(error instanceof Error ? error.message : '修改失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="account-layout">
      <header>
        <a href="/npi">← 新品协同</a>
        <button onClick={() => void logout()}>退出登录</button>
      </header>
      <main>
        <p className="eyebrow">账号与安全</p>
        <h1>{user?.name}</h1>
        <p className="muted">{user?.email}</p>
        {user?.mustChangePassword && (
          <p role="status" className="notice">
            首次登录或密码已重置，请先设置自己的密码。
          </p>
        )}
        <section className="account-card">
          <h2>修改密码</h2>
          <form onSubmit={(e) => void submit(e)}>
            <fieldset disabled={busy}>
              <label>
                原密码
                <input
                  name="oldPassword"
                  type="password"
                  autoComplete="current-password"
                  maxLength={128}
                  required
                />
              </label>
              <label>
                新密码
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={128}
                  required
                />
              </label>
              <label>
                确认新密码
                <input
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={128}
                  required
                />
              </label>
              <p className="muted small">
                10至128个字符。修改后其他设备需要重新登录。
              </p>
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
              {notice && (
                <p role="status" className="notice">
                  {notice}
                </p>
              )}
              <button className="primary">
                {busy ? '正在保存…' : '保存新密码'}
              </button>
              {!user?.mustChangePassword && (
                <a className="account-link" href="/npi">
                  进入工作空间 →
                </a>
              )}
            </fieldset>
          </form>
        </section>
        {user?.role === 'admin' && !user.mustChangePassword && (
          <a className="account-link" href="/accounts">
            管理账号、岗位与登录状态 →
          </a>
        )}
      </main>
    </div>
  )
}
export async function logout() {
  await request('/api/auth/logout', 'POST', {})
  location.assign('/login')
}
export function App() {
  const { user, loading, error, reload } = useAccount()
  if (loading)
    return (
      <main className="loading-page" role="status">
        正在连接新品协同…
      </main>
    )
  if (error)
    return (
      <main className="loading-page">
        <p role="alert">{error}</p>
        <button onClick={() => void reload()}>重试</button>
      </main>
    )
  if (!user) return <Login />
  if (user.mustChangePassword || location.pathname === '/account')
    return <AccountPage />
  if (location.pathname === '/accounts') return <AccountManager />
  return <NpiWorkspace />
}
