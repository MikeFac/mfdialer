import 'webrtc-adapter';
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  ClerkProvider,
  SignIn,
  SignedIn,
  SignedOut,
  UserButton,
  useAuth,
} from '@clerk/clerk-react';
import App from './App.jsx';
import './styles.css';

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function ClerkApp() {
  const { getToken } = useAuth();

  return (
    <>
      <SignedOut>
        <main className="auth-page">
          <section className="auth-panel">
            <h1>Dialer</h1>
            <SignIn routing="hash" />
          </section>
        </main>
      </SignedOut>
      <SignedIn>
        <App
          authHeader={async () => {
            const token = await getToken();
            return token ? { Authorization: `Bearer ${token}` } : {};
          }}
          userMenu={<UserButton afterSignOutUrl="/" />}
        />
      </SignedIn>
    </>
  );
}

function LocalDevApp() {
  return <App authHeader={async () => ({})} userMenu={<span className="local-mode">Local dev</span>} />;
}

createRoot(document.querySelector('#root')).render(
  <React.StrictMode>
    {clerkPublishableKey ? (
      <ClerkProvider publishableKey={clerkPublishableKey}>
        <ClerkApp />
      </ClerkProvider>
    ) : (
      <LocalDevApp />
    )}
  </React.StrictMode>,
);
