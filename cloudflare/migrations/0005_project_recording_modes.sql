-- Project headers remain reusable agreements.  These defaults allow a
-- single-total project to create one accurate, immutable work snapshot.
ALTER TABLE projects ADD COLUMN work_recording_mode TEXT NOT NULL DEFAULT 'Repeating'
  CHECK(work_recording_mode IN ('Single','Repeating'));

ALTER TABLE projects ADD COLUMN default_primary_pay_quantity NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN default_primary_manual_pay NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN default_helper_pay_quantity NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN default_helper_manual_pay NUMERIC NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_projects_recording_mode ON projects(work_recording_mode);
