import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import './index.css'
import App from './App.jsx'
import { CLERK_KEY } from './api.js'

// The admin dashboard is a separate bundle, loaded only on /admin.
const AdminApp = lazy(() => import('./admin/AdminApp.jsx'))

const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin'

// Clerk's sign-in windows in the app's colours.
const appearance = {
  variables: {
    colorPrimary: '#e8572a',
    borderRadius: '12px',
    fontFamily: 'inherit',
  },
}

const page = isAdmin ? (
  <Suspense fallback={null}>
    <AdminApp />
  </Suspense>
) : (
  <App />
)

// Without a Clerk key the app still runs, signed out (see useSession.js).
createRoot(document.getElementById('root')).render(
  <StrictMode>
    {CLERK_KEY ? (
      <ClerkProvider publishableKey={CLERK_KEY} appearance={appearance} afterSignOutUrl="/">
        {page}
      </ClerkProvider>
    ) : (
      page
    )}
  </StrictMode>,
)
