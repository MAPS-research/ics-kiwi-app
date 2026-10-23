import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AdminAppPage from '../pages/admin/AdminAppPage.tsx';

const mocks = vi.hoisted(() => ({ role: vi.fn(), classes: vi.fn(), teaching: vi.fn(),
  binding: vi.fn(), course: vi.fn(), app: vi.fn(), uis: vi.fn() }));
vi.mock('../utils/api.ts', () => ({ default: {
  authControllerGetUserRole: mocks.role, classControllerList: mocks.classes,
  instructorClassControllerGetInstructorClasses: mocks.teaching, classControllerGetById: mocks.course,
}, classAppsApiClient: { classKiwiAppControllerGetClassApps: mocks.binding },
kiwiAppsApiClient: { kiwiAppControllerGetApp: mocks.app, kiwiAppControllerGetAppUIs: mocks.uis } }));
vi.mock('../pages/admin/AdminAppView.tsx', () => ({ default: ({ classId }: { classId?: string }) =>
  <div data-testid="teacher-frame">Course: {classId || 'CLASSLESS'}</div> }));

function openEntry() {
  return render(<MemoryRouter initialEntries={['/admin/app/ics-r-lab']}><Routes>
    <Route path="/admin/app/:appSlug" element={<AdminAppPage />} />
    <Route path="/admin/app/:appSlug/class/:classId" element={<AdminAppPage />} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  cleanup(); vi.resetAllMocks();
  mocks.role.mockResolvedValue({ role: 'admin' });
  mocks.classes.mockResolvedValue({ classIds: ['css-class'] });
  mocks.teaching.mockResolvedValue({ classes: ['taught-class'] });
  mocks.binding.mockResolvedValue([{ slug: 'ics-r-lab', isEnabled: true }]);
  mocks.course.mockImplementation(async ({ classID }) => ({ id: classID, className: `Course ${classID}` }));
  mocks.app.mockResolvedValue({ id: 'app-1', name: 'CSS Lab' });
  mocks.uis.mockResolvedValue([{ id: 'teacher-ui', uiSlug: 'teacher', placement: 'admin-panel', isEnabled: true, uiUrl: 'http://localhost:8100/teacher' }]);
});

describe('CSS Lab teacher entry', () => {
  it('opens the sole enabled course before creating a teacher iframe', async () => {
    openEntry();
    expect(screen.queryByTestId('teacher-frame')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('teacher-frame')).toHaveTextContent('Course: css-class'));
    expect(screen.queryByText('CLASSLESS')).not.toBeInTheDocument();
  });

  it('asks the teacher to choose when several enabled courses exist', async () => {
    mocks.classes.mockResolvedValue({ classIds: ['course-a', 'course-b'] });
    openEntry();
    await screen.findByRole('link', { name: 'Course course-b' });
    expect(mocks.app).not.toHaveBeenCalled();
    expect(screen.queryByTestId('teacher-frame')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Course course-b' }));
    await waitFor(() => expect(screen.getByTestId('teacher-frame')).toHaveTextContent('Course: course-b'));
  });

  it('uses the instructor course list rather than administrator access', async () => {
    mocks.role.mockResolvedValue({ role: 'instructor' });
    mocks.teaching.mockResolvedValue({ classes: [{ id: 'taught-class', classMetadata: { className: 'Real backend shape' } }] });
    openEntry();
    await waitFor(() => expect(screen.getByTestId('teacher-frame')).toHaveTextContent('Course: taught-class'));
    expect(mocks.classes).not.toHaveBeenCalled();
    expect(mocks.binding).toHaveBeenCalledWith({ classId: 'taught-class' });
  });

  it('also accepts the legacy string instructor course contract', async () => {
    mocks.role.mockResolvedValue({ role: 'instructor' });
    openEntry();
    await waitFor(() => expect(screen.getByTestId('teacher-frame')).toHaveTextContent('Course: taught-class'));
    expect(mocks.binding).toHaveBeenCalledWith({ classId: 'taught-class' });
  });

  it('accepts the older classID field and deduplicates course choices', async () => {
    mocks.role.mockResolvedValue({ role: 'instructor' });
    mocks.teaching.mockResolvedValue({ classes: [{ classID: 'taught-class' }, 'taught-class'] });
    openEntry();
    await waitFor(() => expect(screen.getByTestId('teacher-frame')).toHaveTextContent('Course: taught-class'));
    expect(mocks.binding).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed instructor course response as an error', async () => {
    mocks.role.mockResolvedValue({ role: 'instructor' });
    mocks.teaching.mockResolvedValue({ classes: [{ classMetadata: {} }] });
    openEntry();
    await screen.findByRole('button', { name: 'Try again' });
    expect(mocks.binding).not.toHaveBeenCalled();
    expect(screen.queryByTestId('teacher-frame')).not.toBeInTheDocument();
  });

  it('does not create a teacher iframe for a student account', async () => {
    mocks.role.mockResolvedValue({ role: 'user' });
    openEntry();
    await screen.findByText(/not enabled for any of your teaching courses/);
    expect(mocks.classes).not.toHaveBeenCalled();
    expect(mocks.teaching).not.toHaveBeenCalled();
    expect(mocks.app).not.toHaveBeenCalled();
  });

  it('does not launch a disabled binding', async () => {
    mocks.binding.mockResolvedValue([{ slug: 'ics-r-lab', isEnabled: false }]);
    openEntry();
    await screen.findByText(/not enabled for any of your teaching courses/);
    expect(mocks.course).not.toHaveBeenCalled();
    expect(mocks.app).not.toHaveBeenCalled();
  });

  it('shows a retryable failure instead of choosing a course after a failed lookup', async () => {
    mocks.binding.mockRejectedValueOnce(new Error('temporarily unavailable'));
    openEntry();
    await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load your teaching courses');
    expect(screen.queryByTestId('teacher-frame')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('teacher-frame')).toHaveTextContent('Course: css-class'));
  });
});
