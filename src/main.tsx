import { createRoot } from 'react-dom/client'
import { AccountProvider } from './lib/auth/context'
import { App } from './App'
import './styles.css'
createRoot(document.getElementById('root')!).render(
  <AccountProvider>
    <App />
  </AccountProvider>,
)
