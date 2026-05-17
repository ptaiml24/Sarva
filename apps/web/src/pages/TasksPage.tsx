import { Link } from "react-router-dom";

/** Global tasks route — work items live under each project in R1. */
export function TasksPage() {
  return (
    <div data-testid="tasks-page">
      <p className="muted page-intro">
        <strong>Work → Tasks</strong> — backlog and task execution are organized per project.
      </p>
      <div className="card">
        <h2>Where tasks live</h2>
        <p className="muted">
          Tasks are created from PM / planning flows (e.g. propose from intake, board columns) and can be added or edited on the
          project <strong>Board</strong>. Open <Link to="/projects">Projects</Link>, pick a project, then use{" "}
          <strong>Board</strong> or <strong>Plan &amp; backlog</strong>. There is no separate company-wide task list in
          this release.
        </p>
      </div>
    </div>
  );
}
