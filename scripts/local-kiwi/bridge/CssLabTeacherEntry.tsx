import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { Link, useNavigate } from 'react-router-dom';
import apiClient, { classAppsApiClient } from '../utils/api.ts';
import { getAdminAppPath } from '../apps/adminNavigation.ts';

type TeachingCourse = { id: string; label: string };

/** Global app links have no course; resolve one before mounting the course-only Lab. */
export async function loadCssLabTeachingCourses(): Promise<TeachingCourse[]> {
  const { role } = await apiClient.authControllerGetUserRole();
  if (role !== 'admin' && role !== 'instructor') return [];
  const entries: unknown[] = role === 'admin'
    ? (await apiClient.classControllerList()).classIds
    : (await apiClient.instructorClassControllerGetInstructorClasses()).classes;
  // The pinned instructor endpoint returns Class objects although its
  // generated client declares string[]. Accept both contracts explicitly.
  const ids = [...new Set(entries.map(entry => {
    const object = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const id = typeof entry === 'string' ? entry : object.id || object.classID;
    if (typeof id !== 'string' || !id) throw new Error('Invalid teaching course identifier');
    return id;
  }))];
  const courses: TeachingCourse[] = [];
  // Bound lookups for institutions with many courses. Only current course
  // bindings are shown; a failed lookup is an error, never an invented choice.
  for (let offset = 0; offset < ids.length; offset += 6) {
    const batch = await Promise.all(ids.slice(offset, offset + 6).map(async id => {
      const apps = await classAppsApiClient.classKiwiAppControllerGetClassApps({ classId: id });
      if (!apps.some(app => app.slug === 'ics-r-lab' && app.isEnabled)) return null;
      const course = await apiClient.classControllerGetById({ classID: id });
      return { id, label: course.className || 'Untitled course' };
    }));
    for (const course of batch) if (course) courses.push(course);
  }
  return courses.sort((a, b) => a.label.localeCompare(b.label));
}

export function CssLabTeacherEntry() {
  const navigate = useNavigate();
  const [courses, setCourses] = useState<TeachingCourse[] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError(''); setCourses(null);
    void loadCssLabTeachingCourses().then(choices => {
      if (!active) return;
      if (choices.length === 1) navigate(getAdminAppPath('ics-r-lab', choices[0].id), { replace: true });
      else setCourses(choices);
    }).catch(() => { if (active) setError('Could not load your teaching courses. Please try again.'); });
    return () => { active = false; };
  }, [navigate, revision]);
  return <Box component="section" aria-labelledby="css-teacher-entry-title" sx={{ p: { xs: 2, md: 4 }, width: '100%', maxWidth: 760, mx: 'auto' }}>
    <Typography variant="h4" component="h1" id="css-teacher-entry-title" sx={{ mb: 2 }}>CSS Lab · Teacher workspace</Typography>
    {!error && courses === null ? <Stack role="status" direction="row" sx={{ gap: 2, alignItems: 'center' }}><CircularProgress size={22} /><Typography>Opening your teaching course…</Typography></Stack>
      : error ? <><Alert severity="error" sx={{ mb: 2 }}>{error}</Alert><Button variant="contained" onClick={() => setRevision(n => n + 1)}>Try again</Button></>
      : courses?.length ? <><Typography sx={{ mb: 2 }}>Choose the course you want to teach.</Typography><Stack sx={{ gap: 2 }}>{courses.map(course => <Button component={Link} key={course.id} to={getAdminAppPath('ics-r-lab', course.id)} variant="outlined" sx={{ justifyContent: 'flex-start', textTransform: 'none', minHeight: 48, overflowWrap: 'anywhere', textAlign: 'left' }}>{course.label}</Button>)}</Stack></>
      : <Alert severity="info">CSS Lab is not enabled for any of your teaching courses. Open your course settings to check available apps.</Alert>}
    <Button component={Link} to="/admin/classes" sx={{ mt: 3, minHeight: 44, textTransform: 'none' }}>Back to courses</Button>
  </Box>;
}
