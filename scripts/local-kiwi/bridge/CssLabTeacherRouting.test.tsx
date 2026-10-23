import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import AdminAppPage from '../pages/admin/AdminAppPage.tsx';
import AdminLayout from '../pages/admin/AdminLayout.tsx';

// Keep the real layout effects and sidebar callbacks: these used to override
// the app's course picker before it could finish loading the eligible courses.
const mocks = vi.hoisted(() => ({
  role: vi.fn(), classes: vi.fn(), teaching: vi.fn(), binding: vi.fn(),
  course: vi.fn(), app: vi.fn(), uis: vi.fn(), listApps: vi.fn(),
}));
vi.mock('../utils/api.ts', () => ({
  default: {
    authControllerGetUserRole: mocks.role,
    classControllerList: mocks.classes,
    instructorClassControllerGetInstructorClasses: mocks.teaching,
    classControllerGetById: mocks.course,
  },
  classAppsApiClient: { classKiwiAppControllerGetClassApps: mocks.binding },
  kiwiAppsApiClient: {
    kiwiAppControllerGetApp: mocks.app,
    kiwiAppControllerGetAppUIs: mocks.uis,
    kiwiAppControllerListApps: mocks.listApps,
  },
}));
vi.mock('../pages/admin/AdminAppView.tsx', () => ({
  default: ({ classId }: { classId?: string }) => <div data-testid="teacher-frame">Course: {classId}</div>,
}));
vi.mock('../components/TopNav/TopNav.tsx', () => ({
  TOP_NAV_BRAND_AREA_WIDTH: 240, TOP_NAV_HEIGHT: 54,
  default: () => <div>Top nav</div>,
}));
vi.mock('../components/NavigationSidebar/NavigationSidebar.tsx', () => ({
  default: ({ sections }: { sections: { items: { key: string; label: string; onClick: () => void }[] }[] }) =>
    <nav>{sections.flatMap(section => section.items).map(item =>
      <button key={item.key} onClick={item.onClick}>{item.label}</button>)}</nav>,
}));
vi.mock('../hooks/useContentResize.ts', () => ({ useContentResize: () => ({}) }));

function Controls() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/admin/app/ics-r-lab')}>Global teacher entry</button>;
}

function openEntry(path: string) {
  render(<MemoryRouter initialEntries={[path]}><Controls /><Routes>
    <Route path="/admin" element={<AdminLayout />}>
      <Route path="classes" element={<div>Courses page</div>} />
      <Route path="app/:appSlug" element={<AdminAppPage />} />
      <Route path="app/:appSlug/class/:classId" element={<AdminAppPage />} />
    </Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  cleanup(); vi.resetAllMocks();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
  mocks.role.mockResolvedValue({ role: 'instructor' });
  mocks.classes.mockResolvedValue({ classIds: ['b-enabled'] });
  // This is the actual instructor endpoint's payload, despite its generated
  // client declaration claiming that classes is a string array.
  mocks.teaching.mockResolvedValue({ classes: [{ id: 'a-disabled' }, { id: 'b-enabled' }] });
  mocks.course.mockImplementation(async ({ classID }) => ({
    id: classID, className: classID === 'a-disabled' ? 'A first course' : 'B enabled course',
  }));
  mocks.binding.mockImplementation(async ({ classId }) => {
    if (typeof classId !== 'string') throw new Error('Class ID must be a string');
    return classId === 'b-enabled' ? [{ slug: 'ics-r-lab', isEnabled: true }] : [];
  });
  mocks.app.mockResolvedValue({ id: 'app1', name: 'CSS Lab' });
  mocks.listApps.mockResolvedValue([{ slug: 'ics-r-lab', name: 'CSS Lab' }]);
  mocks.uis.mockResolvedValue([{
    id: 'teacher', uiSlug: 'teacher', placement: 'admin-panel', isEnabled: true,
    allowedRoles: ['instructor', 'admin'], uiUrl: 'http://localhost:8100/teacher',
  }]);
});

describe('CSS Lab teacher routing through AdminLayout', () => {
  it('resolves the enabled course from the instructor object payload for a global bookmark', async () => {
    openEntry('/admin/app/ics-r-lab');
    await waitFor(() => expect(screen.getByTestId('teacher-frame')).toHaveTextContent('Course: b-enabled'));
  });

  it('resolves the enabled course when an instructor clicks the global sidebar app', async () => {
    openEntry('/admin/classes');
    await screen.findByRole('button', { name: 'CSS Lab' });
    await waitFor(() => expect(mocks.course).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'CSS Lab' }));
    await waitFor(() => expect(screen.getByTestId('teacher-frame')).toHaveTextContent('Course: b-enabled'));
  });

  it('preserves the course picker when an instructor teaches several enabled courses', async () => {
    mocks.binding.mockResolvedValue([{ slug: 'ics-r-lab', isEnabled: true }]);
    openEntry('/admin/app/ics-r-lab');
    await screen.findByRole('link', { name: 'B enabled course' });
    expect(screen.queryByTestId('teacher-frame')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'B enabled course' }));
    await waitFor(() => expect(screen.getByTestId('teacher-frame')).toHaveTextContent('Course: b-enabled'));
  });

  it('recovers after a previous lookup fails and global entry chooses a good course', async () => {
    mocks.role.mockResolvedValue({ role: 'admin' });
    mocks.app.mockRejectedValueOnce(new Error('temporary first lookup failure'));
    openEntry('/admin/app/ics-r-lab/class/old-class');
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Global teacher entry' }));
    await waitFor(() => expect(mocks.app).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('teacher-frame')).toHaveTextContent('Course: b-enabled'));
  });

  it('ignores an old request failure after the new course has opened', async () => {
    mocks.role.mockResolvedValue({ role: 'admin' });
    let rejectOld: (error: Error) => void = () => { throw new Error('request not started'); };
    mocks.app.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    openEntry('/admin/app/ics-r-lab/class/old-class');
    await waitFor(() => expect(mocks.app).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Global teacher entry' }));
    await waitFor(() => expect(screen.getByTestId('teacher-frame')).toHaveTextContent('Course: b-enabled'));
    await act(async () => { rejectOld(new Error('late old request failure')); await Promise.resolve(); });
    expect(screen.getByTestId('teacher-frame')).toHaveTextContent('Course: b-enabled');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
