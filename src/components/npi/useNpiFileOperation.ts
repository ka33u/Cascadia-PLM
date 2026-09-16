// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useRef, useState } from 'react'

// Each visit gets its own token, including reopening the same file scope.
export function useNpiFileOperation(scope: string | null) {
  const active = useRef({ scope, token: {} })
  if (active.current.scope !== scope) active.current = { scope, token: {} }
  const token = active.current.token
  const pending = useRef({ token, busy: false })
  const [state, setState] = useState({ token, busy: false })
  const onBusyChange = useCallback(
    (busy: boolean) => {
      if (active.current.token !== token) return
      pending.current = { token, busy }
      setState({ token, busy })
    },
    [token],
  )
  return {
    busy: state.token === token && state.busy,
    isBusy: () => pending.current.token === token && pending.current.busy,
    onBusyChange,
  }
}
