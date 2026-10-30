# Patched local Kiwi demo — retired in v0.7.0

The v0.6 clone-and-patch setup is no longer supported. It injected a Lab-specific backend bridge and UI, accessed host data outside the public App API, and replaced the native IDE.

Use [the current setup guide](../set_up_for_agent.md) with an unmodified Kiwi host, or run the Lab standalone with local practice. Existing `.local` checkouts, running processes, SQLite files and Docker volumes are preserved. The retired commands deliberately refuse to run; they do not undo old patches or stop existing services.

The previous instructions remain in Git history at `3cdd34d` for diagnosis only, not deployment.
