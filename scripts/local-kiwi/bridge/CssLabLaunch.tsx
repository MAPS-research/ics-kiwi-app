import { useEffect, useState } from 'react';
import { Button } from '@mui/material';
import ScienceOutlined from '@mui/icons-material/ScienceOutlined';
import { Link } from 'react-router-dom';
import { classAppsApiClient } from '../utils/api.ts';

/** Resolve the course binding, so disabled/unavailable apps have no broken entry. */
export function CssLabLaunch({ classId, teacher = false }: { classId: string; teacher?: boolean }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    void classAppsApiClient.classKiwiAppControllerGetClassApps({ classId })
      .then(apps => { if (active) setEnabled(apps.some(a => a.slug === 'ics-r-lab' && a.isEnabled)); })
      .catch(() => { if (active) setEnabled(false); });
    return () => { active = false; };
  }, [classId]);
  if (!enabled) return null;
  return <Button component={Link} to={teacher ? `/admin/app/ics-r-lab/class/${classId}` : `/${classId}/app/ics-r-lab`}
    startIcon={<ScienceOutlined />} variant="outlined"
    sx={{ mt: 1.5, minHeight: 44, textTransform: 'none', fontWeight: 600, maxWidth: '100%' }}>
    {teacher ? 'Open CSS Lab · teaching & analytics' : 'Open CSS Lab'}
  </Button>;
}
