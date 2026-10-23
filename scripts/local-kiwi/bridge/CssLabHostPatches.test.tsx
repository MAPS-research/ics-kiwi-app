import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { GlobalChatProvider, useGlobalChat } from '../context/GlobalChatContext.tsx';
import { EmbeddedAppChatBar } from './GlobalChat/EmbeddedAppChatBar.tsx';
import { ClassAppView } from '../pages/ClassAppView.tsx';
import ProtectedRoute from '../auth/ProtectedRoute.tsx';
import { Login, safeReturnTo } from '../pages/Login.tsx';

/*
 * CSS Lab host adapters applied by scripts/local-kiwi/frontend.mjs (TELEMETRY-21/22). Copied into src/components and
 * run by scripts/local-kiwi/run-bridge-tests.mjs (`npm run test:bridge`).
 */

const mocks = vi.hoisted(() => ({
  auth: { user: null as null | { id: string; username: string; consent: boolean }, login: vi.fn() },
  role: vi.fn(), profile: vi.fn(), login: vi.fn(), consent: vi.fn(), userRole: vi.fn(),
}));
vi.mock('../auth/AuthContext.tsx', () => ({ useAuth: () => mocks.auth }));
vi.mock('../utils/api.ts', () => {
  const client = {
    authControllerGetProfile: mocks.profile,
    consentControllerGetConsentStatus: mocks.consent,
    authControllerGetUserRole: mocks.userRole,
    authControllerLogin: mocks.login,
  };
  return {
    default: client,
    apiClientWithoutMiddleWare: client,
    permissionsApiClient: { permissionsControllerGetUserClassRole: mocks.role },
    kiwiAppsApiClient: {},
    basePath: 'http://localhost:3000',
  };
});
vi.mock('../components/AuthLayout/AuthLayout.tsx', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('../components/FormCard/FormCard.tsx', () => ({ default: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('../components/Brand/NyuShanghaiLogo.tsx', () => ({ default: () => <div>NYU Shanghai</div> }));
vi.mock('../components/GoogleLoginButton/GoogleLoginButton.tsx', () => ({ GoogleLoginButton: () => <button>Continue with Google</button> }));

const APP_ORIGIN = 'http://localhost:8100';

function ChatProbe() {
  const chat = useGlobalChat();
  return <div>
    <span data-testid="chat-open">{String(chat.isOpen)}</span>
    <span data-testid="chat-available">{String(chat.appChatAvailable)}</span>
    <button onClick={chat.openChat}>probe open</button>
    <button onClick={() => chat.setAppChatAvailability(false, 'Kiwi Chat is off for this homework.')}>probe off</button>
    <button onClick={() => chat.setAppChatAvailability(true)}>probe on</button>
  </div>;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function postFromApp(type: string, payload: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { origin: APP_ORIGIN, data: { type, payload } }));
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.auth.user = null;
  mocks.role.mockResolvedValue({ role: 'student' });
  mocks.profile.mockResolvedValue({ sub: 'u1', email: 'ada@example.edu' });
  mocks.consent.mockResolvedValue(true);
  mocks.userRole.mockResolvedValue({ role: 'instructor' });
  mocks.login.mockResolvedValue({ accessToken: 'test-token' });
  sessionStorage.clear();
  localStorage.clear();
});

describe('kiwi:setChatAvailability host patch (TELEMETRY-21)', () => {
  it('hides chat while unavailable', () => {
    render(<MemoryRouter><GlobalChatProvider><EmbeddedAppChatBar /><ChatProbe /></GlobalChatProvider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'open chat' }));
    expect(screen.getByTestId('chat-open')).toHaveTextContent('true');
    fireEvent.click(screen.getByText('probe off'));
    expect(screen.getByTestId('chat-open')).toHaveTextContent('false');
    expect(screen.queryByRole('button', { name: 'open chat' })).not.toBeInTheDocument();
    expect(screen.getByText('Kiwi Chat is off for this homework.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('probe open'));
    expect(screen.getByTestId('chat-open')).toHaveTextContent('false');
    fireEvent.click(screen.getByText('probe on'));
    expect(screen.getByRole('button', { name: 'open chat' })).toBeInTheDocument();
  });

  it('the app page message closes and hides the chat; available:true or unmount restores it', async () => {
    mocks.auth.user = { id: 'u1', username: 'ada@example.edu', consent: true };
    const view = <ClassAppView appId="app-1" appSlug="ics-r-lab" uiUrl={`${APP_ORIGIN}/student`} appName="CSS R Practice" />;
    const { rerender } = render(<MemoryRouter initialEntries={['/class-1/app/ics-r-lab']}><GlobalChatProvider>
      <ChatProbe />
      <Routes><Route path="/:classID/app/:appSlug" element={view} /></Routes>
    </GlobalChatProvider></MemoryRouter>);
    fireEvent.click(screen.getByText('probe open'));
    expect(screen.getByTestId('chat-open')).toHaveTextContent('true');
    postFromApp('kiwi:setChatAvailability', { available: false, reason: 'Ask Kiwi is off for this homework.' });
    expect(screen.getByTestId('chat-open')).toHaveTextContent('false');
    expect(screen.getByTestId('chat-available')).toHaveTextContent('false');
    expect(screen.queryByRole('button', { name: 'open chat' })).not.toBeInTheDocument();
    postFromApp('kiwi:setChatAvailability', { available: true });
    expect(screen.getByTestId('chat-available')).toHaveTextContent('true');
    expect(screen.getByRole('button', { name: 'open chat' })).toBeInTheDocument();
    postFromApp('kiwi:setChatAvailability', { available: false });
    expect(screen.getByTestId('chat-available')).toHaveTextContent('false');
    rerender(<MemoryRouter initialEntries={['/class-1/app/ics-r-lab']}><GlobalChatProvider>
      <ChatProbe />
      <Routes><Route path="/:classID/app/:appSlug" element={<div>other page</div>} /></Routes>
    </GlobalChatProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('chat-available')).toHaveTextContent('true'));
  });

  it('ignores messages from other origins', () => {
    mocks.auth.user = { id: 'u1', username: 'ada@example.edu', consent: true };
    render(<MemoryRouter initialEntries={['/class-1/app/ics-r-lab']}><GlobalChatProvider>
      <ChatProbe />
      <Routes><Route path="/:classID/app/:appSlug" element={
        <ClassAppView appId="app-1" appSlug="ics-r-lab" uiUrl={`${APP_ORIGIN}/student`} appName="CSS R Practice" />} /></Routes>
    </GlobalChatProvider></MemoryRouter>);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', data: { type: 'kiwi:setChatAvailability', payload: { available: false } } }));
    });
    expect(screen.getByTestId('chat-available')).toHaveTextContent('true');
  });
});

describe('return to the requested page after sign-in (TELEMETRY-22)', () => {
  it('redirects an unauthenticated visit to /login?returnTo=<path+search>', async () => {
    render(<MemoryRouter initialEntries={['/admin/app/ics-r-lab?tab=home']}><Routes>
      <Route path="/admin/app/:appSlug" element={<ProtectedRoute><div>Teacher entry</div></ProtectedRoute>} />
      <Route path="/login" element={<LocationProbe />} />
    </Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login?returnTo=%2Fadmin%2Fapp%2Fics-r-lab%3Ftab%3Dhome'));
  });

  it('returns to the requested path after login', async () => {
    vi.stubEnv('VITE_DISABLE_PASSWORD_LOGIN', 'false');
    render(<MemoryRouter initialEntries={['/login?returnTo=%2Fadmin%2Fapp%2Fics-r-lab']}><Routes>
      <Route path="/login" element={<Login />} />
      <Route path="*" element={<LocationProbe />} />
    </Routes></MemoryRouter>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'teacher@example.edu' } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'secret-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/admin/app/ics-r-lab'));
    vi.unstubAllEnvs();
  });

  it('never follows an off-site returnTo (open-redirect guard)', () => {
    expect(safeReturnTo('?returnTo=%2Fadmin%2Fapp%2Fics-r-lab')).toBe('/admin/app/ics-r-lab');
    expect(safeReturnTo('?returnTo=%2F%2Fevil.example%2Fx')).toBeNull();
    expect(safeReturnTo('?returnTo=https%3A%2F%2Fevil.example')).toBeNull();
    expect(safeReturnTo('?returnTo=%2F%5Cevil.example')).toBeNull();
    expect(safeReturnTo('')).toBeNull();
  });
});
