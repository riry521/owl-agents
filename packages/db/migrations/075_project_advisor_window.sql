-- Whether the Project's Advisor window is listed. Off by default; a window with channel bindings is listed regardless.
ALTER TABLE projects ADD COLUMN advisor_window_enabled INTEGER NOT NULL DEFAULT 0 CHECK (advisor_window_enabled IN (0, 1));
