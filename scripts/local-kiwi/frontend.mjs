#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
// KIWI_UI_DIR points the patcher at another Kiwi UI tree (e.g. a temporary copy used by bridge tests).
export const frontendDirectory = process.env.KIWI_UI_DIR ? path.resolve(process.env.KIWI_UI_DIR) : path.join(workspace, '.local', 'kiwi-ui');

const embeddedAppChatBar = `import { Box, Button, Typography } from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';
import { useGlobalChat } from '../../context/GlobalChatContext.tsx';

/** A normal-flow chat entry keeps embedded apps free of overlays at every width.
 * While the app page turns Kiwi's chat off (kiwi:setChatAvailability), the open button is hidden. */
export function EmbeddedAppChatBar() {
  const { openChat, appChatAvailable, appChatUnavailableReason } = useGlobalChat();
  return <Box component="nav" aria-label="Kiwi App tools" sx={{
    display: 'flex', flexShrink: 0, minHeight: 44,
    px: 1, alignItems: 'center', bgcolor: 'background.paper',
    borderBottom: 1, borderColor: 'divider',
  }}>{appChatAvailable ? <Button aria-label="open chat" onClick={openChat} startIcon={<ChatIcon />} sx={{
    minHeight: 44, fontSize: 12, fontWeight: 600, textTransform: 'none',
  }}>Kiwi Chat</Button> : <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
    {appChatUnavailableReason || 'Kiwi Chat is not available on this page.'}</Typography>}</Box>;
}
`;

/** Bridge UI files copied into src/components (tests run with `npm run test:bridge`). */
export const BRIDGE_COMPONENT_FILES = ['CssLabTeacherEntry.tsx', 'CssLabTeacherEntry.test.tsx', 'CssLabTeacherRouting.test.tsx',
  'CssLabHostPatches.test.tsx'];
export const BRIDGE_UI_TESTS = BRIDGE_COMPONENT_FILES.filter(name => name.endsWith('.test.tsx'));

// Local compatibility fixes for upstream fbc29be, confined to narrow host
// navigation, app deep links and a normal-flow app chat entry. The official theme is unchanged.
export async function applyFrontendPatches({ dryRun = false } = {}) {
  const replacements = [
    {
      relative: 'src/pages/admin/AdminLayout.tsx',
      before: '      !activeAdminAppSlug ||\n      classScopeRoute.classId ||',
      after: '      !activeAdminAppSlug ||\n      activeAdminAppSlug === "ics-r-lab" ||\n      classScopeRoute.classId ||',
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminLayout.tsx',
      before: '              if (userRole === "instructor") {\n                const firstAssignedClass',
      after: '              if (userRole === "instructor" && app.slug !== "ics-r-lab") {\n                const firstAssignedClass',
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: "import AdminAppView from './AdminAppView.tsx';",
      after: "import AdminAppView from './AdminAppView.tsx';\nimport { CssLabTeacherEntry } from '../../components/CssLabTeacherEntry.tsx';",
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: '      if (!appSlug) {',
      after: "      if (appSlug === 'ics-r-lab' && !classId) return;\n      if (!appSlug) {",
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: '  if (loading) {',
      previous: "  if (appSlug === 'ics-r-lab' && !classId) return <CssLabTeacherEntry />;\n\n  if (loading) {",
      after: "  if (appSlug === 'ics-r-lab' && !classId) return <CssLabTeacherEntry />;\n\n  if (loading || resolvedScope !== scopeKey) {",
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: "  const [error, setError] = useState<string | null>(null);",
      after: "  const [error, setError] = useState<string | null>(null);\n  const scopeKey = JSON.stringify([appSlug, classId]);\n  const [resolvedScope, setResolvedScope] = useState<string | null>(null);",
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: '  useEffect(() => {\n    const fetchAppUI = async () => {',
      after: '  useEffect(() => {\n    let cancelled = false;\n    const fetchAppUI = async () => {',
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: "        setError('Missing app slug');\n        setLoading(false);",
      after: "        setError('Missing app slug');\n        setResolvedScope(scopeKey);\n        setLoading(false);",
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: '      try {\n        setLoading(true);',
      after: '      try {\n        setLoading(true);\n        setError(null);\n        setAppUI(null);',
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: '        setAppName(appDetails.name);',
      after: '        if (cancelled) return;\n        setAppName(appDetails.name);',
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: '        // Exercise Manager is a single admin surface.',
      after: '        if (cancelled) return;\n\n        // Exercise Manager is a single admin surface.',
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: "        console.error('Error fetching app UI:', err);",
      after: "        if (cancelled) return;\n        console.error('Error fetching app UI:', err);",
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: '      } finally {\n        setLoading(false);\n      }',
      after: '      } finally {\n        if (!cancelled) { setResolvedScope(scopeKey); setLoading(false); }\n      }',
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: '    fetchAppUI();\n  }, [appSlug, classId]);',
      after: '    fetchAppUI();\n    return () => { cancelled = true; };\n  }, [appSlug, classId, scopeKey]);',
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppPage.tsx',
      before: '    <AdminAppView\n      appId={appUI.id}',
      after: '    <AdminAppView\n      key={`${appSlug}:${classId || ""}:${appUI.uiSlug}`}\n      appId={appUI.id}',
      count: 1,
    },
    {
      relative: 'src/pages/Logout.tsx',
      before: 'import { useAuth } from "../auth/AuthContext.tsx";',
      after: 'import { useAuth } from "../auth/AuthContext.tsx";\nimport { useEffect, useRef } from "react";\nimport { useNavigate } from "react-router-dom";',
      count: 1,
    },
    {
      relative: 'src/pages/Logout.tsx',
      before: '  logout();\n  return <div>Logout</div>;',
      after: '  const logoutRef = useRef(logout);\n  const navigate = useNavigate();\n  useEffect(() => { logoutRef.current(); navigate("/login", { replace: true }); }, [navigate]);\n  return <div>Signing out…</div>;',
      count: 1,
    },
    {
      relative: 'src/components/CodeInterpreter/IDE.tsx',
      before: '  const [SnackbarOpen, setSnackbarOpen] = React.useState(false);',
      after: '  const [SnackbarOpen, setSnackbarOpen] = React.useState(false);\n  const [running, setRunning] = useState(false);',
      count: 1,
    },
    {
      relative: 'src/components/CodeInterpreter/IDE.tsx',
      before: '                  runCode(IDECode);\n                  SnackbarActivate();',
      after: '                  if (running) return;\n                  setRunning(true);\n                  void runCode(IDECode).finally(() => { setRunning(false); SnackbarActivate(); });',
      count: 2,
    },
    {
      relative: 'src/components/CodeInterpreter/IDE.tsx',
      before: '                color="primary"\n                onClick={() => {',
      after: '                color="primary"\n                aria-label={running ? "Running code" : "Run code"}\n                disabled={running}\n                onClick={() => {',
      count: 2,
    },
    {
      relative: 'src/components/CodeInterpreter/IDE.tsx',
      before: 'message="Code executed and files updated."',
      after: 'message="Code execution finished. Check the output for results or errors."',
      count: 1,
    },
    {
      relative: 'src/pages/Courses.tsx',
      before: 'import ClassCard',
      after: "import { CssLabLaunch } from '../components/CssLabLaunch.tsx';\nimport ClassCard",
      count: 1,
    },
    {
      relative: 'src/pages/Courses.tsx',
      before: '              <ClassCard',
      after: '              <Box key={course.id} sx={{ minWidth: 0 }}><ClassCard',
      count: 1,
    },
    {
      relative: 'src/pages/Courses.tsx',
      before: 'routeState={{ className: course.className }}\n              />',
      after: 'routeState={{ className: course.className }}\n              />{course.id && <CssLabLaunch classId={course.id} />}</Box>',
      count: 1,
    },
    {
      relative: 'src/pages/admin/Classes.tsx',
      before: 'import ClassCard',
      after: "import { CssLabLaunch } from '../../components/CssLabLaunch.tsx';\nimport ClassCard",
      count: 1,
    },
    {
      relative: 'src/pages/admin/Classes.tsx',
      before: 'routeState={{ className: classInfo.className }}\n                    />',
      after: 'routeState={{ className: classInfo.className }}\n                    /><CssLabLaunch classId={classInfo.classID} teacher />',
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppView.tsx',
      before: "        case 'kiwi:navigate':\n          // App requests navigation\n          console.log('[AdminAppView] Navigation request:', payload);\n          break;",
      after: `        case 'kiwi:navigate': {
          const destination = payload?.path === '/' ? '/admin/classes' : payload?.path;
          const allowed = destination === '/admin/classes' ||
            (effectiveClassId && destination === '/admin/class/' + effectiveClassId);
          if (payload?.requestId) event.source && (event.source as Window).postMessage({
            type: 'kiwi:ack', payload: { requestId: payload.requestId, ok: Boolean(allowed),
              ...(!allowed ? { error: { code: 'forbidden', message: 'Navigation outside the current course is unavailable.' } } : {}) },
          }, { targetOrigin: appOrigin });
          if (allowed) navigate(destination);
          break;
        }`,
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppView.tsx',
      before: 'uiSlug, sendAppToken, setAppNavigation]);',
      after: 'uiSlug, sendAppToken, setAppNavigation, navigate]);',
      count: 1,
    },
    {
      relative: 'src/components/CodeInterpreter/IDE.tsx',
      before: '        userCode: code,\n        outputCode: output,',
      previous: '        userCode: code,\n        outputCode: output,\n        success: Boolean(result) && !result?.error,\n        error: result?.error || null,',
      after: '        userCode: code,\n        outputCode: output,\n        success: Boolean(result) && !result?.error,\n        error: result?.error || null,\n        resultVersion: "captured-result-v1",\n        language: selectedLanguage,',
      count: 1,
    },
    {
      relative: 'src/pages/ClassLayout.tsx',
      before: '  const [enabledApps, setEnabledApps] = useState<ClassAppResponseDto[]>([]);',
      after: '  const [enabledApps, setEnabledApps] = useState<ClassAppResponseDto[]>([]);\n  const [enabledAppsClassId, setEnabledAppsClassId] = useState<string>();',
      count: 1,
    },
    {
      relative: 'src/pages/ClassLayout.tsx',
      before: '    if (!classID || menuItems.length === 0 || hasUserChangedTabRef.current) {',
      after: '    // An app deep link is not an unknown tab until this class\'s app list resolves.\n    if (!classID || enabledAppsClassId !== classID || menuItems.length === 0 || hasUserChangedTabRef.current) {',
      count: 1,
    },
    {
      relative: 'src/pages/ClassLayout.tsx',
      before: '  }, [classID, currentTabIndex, location.pathname, menuItems, navigate]);',
      after: '  }, [classID, enabledAppsClassId, currentTabIndex, location.pathname, menuItems, navigate]);',
      count: 1,
    },
    {
      relative: 'src/pages/ClassLayout.tsx',
      before: '  useEffect(() => {\n    const fetchClass = async () => {',
      after: '  useEffect(() => {\n    let cancelled = false;\n    const fetchClass = async () => {',
      count: 1,
    },
    {
      relative: 'src/pages/ClassLayout.tsx',
      before: '        // Sort by tabOrder\n        apps.sort((a, b) => a.tabOrder - b.tabOrder);\n        setEnabledApps(apps);',
      after: '        if (cancelled) return;\n        // Only a completed lookup for the current class may enable route fallback.\n        apps.sort((a, b) => a.tabOrder - b.tabOrder);\n        setEnabledApps(apps);\n        setEnabledAppsClassId(classID);',
      count: 1,
    },
    {
      relative: 'src/pages/ClassLayout.tsx',
      before: '    fetchEnabledApps();\n  }, [classID]);',
      after: '    fetchEnabledApps();\n    return () => { cancelled = true; };\n  }, [classID]);',
      count: 1,
    },
    {
      relative: 'src/components/TopNav/TopNav.tsx',
      before: '          pr: 2,\n          "@media (min-width:600px)": {',
      after: '          pr: 2,\n          "@media (max-width:399px)": { pl: 1, pr: 1 },\n          "@media (min-width:600px)": {',
      count: 1,
    },
    {
      relative: 'src/components/TopNav/TopNav.tsx',
      before: 'sx={{ ...headerIconButtonSx, mr: 1 }}',
      after: 'sx={{ ...headerIconButtonSx, mr: 1, "@media (max-width:399px)": { ml: 0, mr: 0 } }}',
      count: 3,
    },
    {
      relative: 'src/components/TopNav/TopNav.tsx',
      before: '            flexShrink: 0,\n            height: 44,',
      after: '            flexShrink: 0,\n            height: 44,\n            "@media (max-width:399px)": { width: 96, "& > [role=\\"img\\"]": { width: 96, height: 24 } },',
      count: 1,
    },
    {
      relative: 'src/components/TopNav/TopNav.tsx',
      before: '                bgcolor: "divider",\n              }}',
      after: '                bgcolor: "divider",\n                "@media (max-width:399px)": { ml: 0.5, mr: 0.5 },\n              }}',
      count: 1,
    },
    {
      relative: 'src/components/TopNav/TopNav.tsx',
      before: '                maxWidth: { xs: 200, sm: 280, md: 360 },\n                display:',
      after: '                maxWidth: { xs: 200, sm: 280, md: 360 },\n                "@media (max-width:399px)": { minWidth: showClassSwitcher ? 36 : 0, maxWidth: showClassSwitcher ? 36 : 96 },\n                display:',
      count: 1,
    },
    {
      relative: 'src/components/TopNav/ClassSwitcher.tsx',
      before: '          color: "text.primary",\n        }}\n      >',
      after: '          color: "text.primary",\n          "@media (max-width:399px)": { minWidth: 36, px: 0, gap: 0, "& > .MuiSvgIcon-root, & > .MuiTypography-root": { display: "none" } },\n        }}\n      >',
      count: 1,
    },
    {
      relative: 'src/components/GlobalChat/GlobalChatContainer.tsx',
      before: "import React from 'react';",
      previous: "import React from 'react';\nimport { useMediaQuery } from '@mui/material';\nimport { useLocation } from 'react-router-dom';",
      after: "import React from 'react';\nimport { useLocation } from 'react-router-dom';",
      count: 1,
    },
    {
      relative: 'src/components/GlobalChat/GlobalChatContainer.tsx',
      before: '  const { user } = useAuth();',
      previous: "  const { user } = useAuth();\n  const location = useLocation();\n  const isNarrow = useMediaQuery('(max-width:599px)');\n  const inlineAppChat = isNarrow && location.pathname.includes('/app/');",
      after: "  const { user } = useAuth();\n  const location = useLocation();\n  const inlineAppChat = location.pathname.includes('/app/');",
      count: 1,
    },
    {
      relative: 'src/components/GlobalChat/GlobalChatContainer.tsx',
      before: '      <GlobalChatButton />',
      previous: '      <GlobalChatButton visible={!inlineAppChat} />',
      after: '      <GlobalChatButton visible={!inlineAppChat && appChatAvailable} />',
      count: 1,
    },
    // v0.6 host adapter 1 (TELEMETRY-21, AU-D2-11, F02): kiwi:setChatAvailability {available, reason}. While an app page
    // sends available:false, Kiwi's global chat is closed and its open buttons are hidden; available:true or leaving
    // the app page restores it. Unpatched hosts ignore the unknown message, so the Lab degrades to guidance mode.
    {
      relative: 'src/components/GlobalChat/GlobalChatContainer.tsx',
      before: "import { GlobalChatModal } from './GlobalChatModal.tsx';",
      after: "import { GlobalChatModal } from './GlobalChatModal.tsx';\nimport { useGlobalChat } from '../../context/GlobalChatContext.tsx';",
      count: 1,
    },
    {
      relative: 'src/components/GlobalChat/GlobalChatContainer.tsx',
      before: "  const inlineAppChat = location.pathname.includes('/app/');",
      after: "  const inlineAppChat = location.pathname.includes('/app/');\n  const { appChatAvailable } = useGlobalChat();",
      count: 1,
    },
    {
      relative: 'src/context/GlobalChatContext.tsx',
      before: '  // Pending prompt from IDE or other sources\n  pendingPrompt?: string;',
      after: '  // Whether the embedded app allows Kiwi\'s own chat on this page (kiwi:setChatAvailability, CSS Lab host patch)\n  appChatAvailable: boolean;\n  appChatUnavailableReason?: string;\n  // Pending prompt from IDE or other sources\n  pendingPrompt?: string;',
      count: 1,
    },
    {
      relative: 'src/context/GlobalChatContext.tsx',
      before: '  // Pending prompt (from IDE export code, etc.)\n  setPendingPrompt: (prompt: string | undefined) => void;',
      after: '  // App chat availability (from kiwi:setChatAvailability)\n  setAppChatAvailability: (available: boolean, reason?: string) => void;\n\n  // Pending prompt (from IDE export code, etc.)\n  setPendingPrompt: (prompt: string | undefined) => void;',
      count: 1,
    },
    {
      relative: 'src/context/GlobalChatContext.tsx',
      before: '  // Pending prompt (from IDE export code, etc.)\n  const [pendingPrompt, setPendingPrompt] = useState<string | undefined>();',
      after: [
        '  // App chat availability (CSS Lab host patch): an app page can hide Kiwi\'s own chat, e.g. graded homework.',
        '  const [appChatAvailable, setAppChatAvailableState] = useState(true);',
        '  const [appChatUnavailableReason, setAppChatUnavailableReason] = useState<string | undefined>();',
        '  const appChatAvailableRef = React.useRef(true);',
        '  const setAppChatAvailability = useCallback((available: boolean, reason?: string) => {',
        '    appChatAvailableRef.current = available;',
        '    setAppChatAvailableState(available);',
        '    setAppChatUnavailableReason(available ? undefined : reason);',
        '    if (!available) setIsOpen(false);',
        '  }, []);',
        '',
        '  // Pending prompt (from IDE export code, etc.)',
        '  const [pendingPrompt, setPendingPrompt] = useState<string | undefined>();',
      ].join('\n'),
      count: 1,
    },
    {
      relative: 'src/context/GlobalChatContext.tsx',
      before: '  const openChat = useCallback(() => setIsOpen(true), []);\n  const closeChat = useCallback(() => setIsOpen(false), []);\n  const toggleChat = useCallback(() => setIsOpen((prev) => !prev), []);',
      after: '  const openChat = useCallback(() => { if (appChatAvailableRef.current) setIsOpen(true); }, []);\n  const closeChat = useCallback(() => setIsOpen(false), []);\n  const toggleChat = useCallback(() => setIsOpen((prev) => (appChatAvailableRef.current ? !prev : false)), []);',
      count: 1,
    },
    {
      relative: 'src/context/GlobalChatContext.tsx',
      before: '    appTutoringMode,\n    pendingPrompt,\n    pendingCode,',
      after: '    appTutoringMode,\n    appChatAvailable,\n    appChatUnavailableReason,\n    pendingPrompt,\n    pendingCode,',
      count: 1,
    },
    {
      relative: 'src/context/GlobalChatContext.tsx',
      before: '    // Pending prompt\n    setPendingPrompt,\n    clearPendingPrompt,',
      after: '    // App chat availability\n    setAppChatAvailability,\n\n    // Pending prompt\n    setPendingPrompt,\n    clearPendingPrompt,',
      count: 1,
    },
    {
      relative: 'src/pages/ClassAppView.tsx',
      before: '  const { setAppContext, setAppPreferredMode, setAppTutoringMode, setDisplayMode, openChat } =\n    useGlobalChat();',
      after: '  const { setAppContext, setAppPreferredMode, setAppTutoringMode, setDisplayMode, openChat, setAppChatAvailability } =\n    useGlobalChat();',
      count: 1,
    },
    {
      relative: 'src/pages/ClassAppView.tsx',
      before: '      setAppTutoringMode(undefined);\n    };\n  }, [setAppContext, setAppPreferredMode, setAppTutoringMode]);',
      after: '      setAppTutoringMode(undefined);\n      setAppChatAvailability(true);\n    };\n  }, [setAppContext, setAppPreferredMode, setAppTutoringMode, setAppChatAvailability]);',
      count: 1,
    },
    {
      relative: 'src/pages/ClassAppView.tsx',
      before: "        case 'kiwi:apiRequest':",
      after: [
        "        case 'kiwi:setChatAvailability':",
        '          // CSS Lab host patch: an app page may hide Kiwi\'s own chat (graded homework with Ask Kiwi off).',
        "          setAppChatAvailability(payload?.available !== false, typeof payload?.reason === 'string' ? payload.reason.slice(0, 300) : undefined);",
        '          ack(true);',
        '          break;',
        '',
        "        case 'kiwi:apiRequest':",
      ].join('\n'),
      count: 1,
    },
    // v0.6 host adapter 2 (TELEMETRY-22): return to the requested page after sign-in. returnTo must be a same-origin
    // path (starts with "/" and not "//" or "/\\"), so the parameter cannot become an open redirect.
    {
      relative: 'src/auth/ProtectedRoute.tsx',
      before: '  if (!user) {\n    return <Navigate to="/login" replace />;\n  }',
      after: '  if (!user) {\n    const returnTo = location.pathname + location.search;\n    return <Navigate to={returnTo && returnTo !== "/" ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login"} replace />;\n  }',
      count: 1,
    },
    {
      relative: 'src/pages/Login.tsx',
      before: 'export const Login: React.FC = () => {',
      after: [
        '/** CSS Lab host patch: the page that required sign-in, when it is a same-origin path (no open redirect). */',
        'export function safeReturnTo(search: string): string | null {',
        '  const value = new URLSearchParams(search).get("returnTo");',
        '  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\\\")) return null;',
        '  return value;',
        '}',
        '',
        'export const Login: React.FC = () => {',
      ].join('\n'),
      count: 1,
    },
    {
      relative: 'src/pages/Login.tsx',
      before: '    try {\n      const tokenResponse = await apiClientWithoutMiddleWare.authControllerLogin({',
      after: '    const returnTo = safeReturnTo(location.search);\n    try {\n      const tokenResponse = await apiClientWithoutMiddleWare.authControllerLogin({',
      count: 1,
    },
    {
      relative: 'src/pages/Login.tsx',
      before: '          navigate("/admin");\n        } else {\n          navigate("/");\n        }',
      after: '          navigate(returnTo ?? "/admin");\n        } else {\n          navigate(returnTo ?? "/");\n        }',
      count: 1,
    },
    {
      relative: 'src/pages/Login.tsx',
      before: '        navigate("/");\n      }\n    } catch (error) {',
      after: '        navigate(returnTo ?? "/");\n      }\n    } catch (error) {',
      count: 1,
    },
    {
      relative: 'src/pages/ClassAppView.tsx',
      before: "import { useGlobalChat } from '../context/GlobalChatContext.tsx';",
      after: "import { useGlobalChat } from '../context/GlobalChatContext.tsx';\nimport { EmbeddedAppChatBar } from '../components/GlobalChat/EmbeddedAppChatBar.tsx';",
      count: 1,
    },
    {
      relative: 'src/pages/ClassAppView.tsx',
      before: "        display: 'flex',\n        width: '100%',\n        height: '100%',\n        minHeight: 'calc(100vh - 180px)',",
      after: "        display: 'flex',\n        flexDirection: 'column',\n        width: '100%',\n        height: '100%',\n        minHeight: 'calc(100vh - 180px)',",
      count: 1,
    },
    {
      relative: 'src/pages/ClassAppView.tsx',
      before: '      {/* Iframe Container */}',
      after: '      <EmbeddedAppChatBar />\n      {/* Iframe Container */}',
      count: 1,
    },
    {
      relative: 'src/pages/ClassAppView.tsx',
      before: "          flex: '1 1 100%',\n          height: '100%',",
      after: "          flex: 1,\n          minHeight: 0,\n          height: '100%',",
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppView.tsx',
      before: "import { useAdminNavigation } from '../../context/AdminNavigationContext.tsx';",
      after: "import { useAdminNavigation } from '../../context/AdminNavigationContext.tsx';\nimport { EmbeddedAppChatBar } from '../../components/GlobalChat/EmbeddedAppChatBar.tsx';",
      count: 1,
    },
    {
      relative: 'src/pages/admin/AdminAppView.tsx',
      before: "        overflow: 'hidden',\n      }}\n    >\n      <Box\n        sx={{\n          position: 'relative',\n          flex: 1,",
      after: "        overflow: 'hidden',\n      }}\n    >\n      <EmbeddedAppChatBar />\n      <Box\n        sx={{\n          position: 'relative',\n          flex: 1,",
      count: 1,
    },
  ];
  const files = new Map(await Promise.all([...new Set(replacements.map(item => item.relative))].map(async relative =>
    [relative, await readFile(path.join(frontendDirectory, relative), 'utf8')])));
  const originals = new Map(files);
  for (const { relative, before, previous, after, count } of replacements) {
    const content = files.get(relative);
    if (content.includes(after)) continue;
    // Support updating the previous local patch without reapplying its imports.
    const source = previous && content.includes(previous) ? previous : before;
    if (content.split(source).length - 1 !== count) throw new Error(`Kiwi UI compatibility patch no longer matches ${relative}; review the upstream change.`);
    files.set(relative, content.replaceAll(source, after));
  }
  if (dryRun) return [...files.keys()];
  for (const name of ['WebR.tsx']) await writeFile(path.join(frontendDirectory, 'src/components/CodeInterpreter', name),
    await readFile(new URL(`./bridge/${name}`, import.meta.url), 'utf8'));
  // v0.6 rEngine captures plots whenever the browser has an OffscreenCanvas, so it is copied unchanged.
  await writeFile(path.join(frontendDirectory, 'src/components/CodeInterpreter/LabRRuntime.ts'),
    await readFile(path.join(workspace, 'src/lib/rEngine.ts'), 'utf8'));
  await cp(path.join(workspace, 'public/webr'), path.join(frontendDirectory, 'public/webr'), { recursive: true });
  await writeFile(path.join(frontendDirectory, 'src/components/CssLabLaunch.tsx'),
    await readFile(new URL('./bridge/CssLabLaunch.tsx', import.meta.url), 'utf8'));
  for (const name of BRIDGE_COMPONENT_FILES) {
    await writeFile(path.join(frontendDirectory, 'src/components', name),
      await readFile(new URL(`./bridge/${name}`, import.meta.url), 'utf8'));
  }
  const chatBarPath = path.join(frontendDirectory, 'src/components/GlobalChat/EmbeddedAppChatBar.tsx');
  const currentChatBar = await readFile(chatBarPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (currentChatBar !== embeddedAppChatBar) await writeFile(chatBarPath, embeddedAppChatBar);
  for (const [relative, content] of files) if (originals.get(relative) !== content)
    await writeFile(path.join(frontendDirectory, relative), content);
  return [...files.keys()];
}

// This frontend file contains public addresses only. OpenAI credentials belong
// exclusively to the backend and must never use a VITE_ variable.
export async function configureFrontend() {
  await access(path.join(frontendDirectory, 'package.json'));
  await applyFrontendPatches();
  await writeFile(path.join(frontendDirectory, '.env.local'), [
    'VITE_BASE_PATH=http://localhost:3000',
    'VITE_BACKEND_URL=http://localhost:3000',
    'VITE_DISABLE_PASSWORD_LOGIN=false',
    '',
  ].join('\n'));
}

export async function setupFrontend() {
  await configureFrontend();
  const installation = spawn('npm', ['ci', '--no-audit', '--no-fund'], {
    cwd: frontendDirectory,
    env: process.env,
    stdio: 'inherit',
  });
  await new Promise((resolve, reject) => {
    installation.once('error', reject);
    installation.once('exit', code => code === 0 ? resolve() : reject(new Error(`Kiwi UI dependency installation exited with code ${code}.`)));
  });
}

export async function startFrontend({ stdio = 'inherit' } = {}) {
  await configureFrontend();
  const vite = path.join(frontendDirectory, 'node_modules', 'vite', 'bin', 'vite.js');
  await access(vite);
  return spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', '3001', '--strictPort'], {
    cwd: frontendDirectory,
    env: { ...process.env, BROWSER: 'none' },
    stdio,
  });
}

async function main() {
  const action = process.argv[2] || 'start';
  if (action === 'setup') {
    await setupFrontend();
    return;
  }
  if (action !== 'start') throw new Error('Usage: node scripts/local-kiwi/frontend.mjs [setup|start]');
  const child = await startFrontend();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
