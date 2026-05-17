import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext.js";
import { AppShell } from "./layout/AppShell.js";
import { LoginPage } from "./pages/Login.js";
import { DashboardPage } from "./pages/Dashboard.js";
import { BusinessUnitsPage } from "./pages/BusinessUnitsPage.js";
import { WorkspacePage } from "./pages/WorkspacePage.js";
import { GuidedSetupPage } from "./pages/GuidedSetupPage.js";
import { SkillsModelsPage } from "./pages/SkillsModelsPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { ProjectLayout } from "./pages/ProjectLayout.js";
import {
  ProjectBoardTab,
  ProjectBacklogTab,
  ProjectChatTab,
  ProjectActivityLogTab,
  ProjectIntakeTab,
  ProjectDesignTab,
  ProjectRequirementsTab,
  ProjectPlanTab,
  ProjectSprintsTab,
} from "./pages/projectTabs.js";
import { AdminPage } from "./pages/AdminPage.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";
import { ChatPage } from "./pages/ChatPage.js";
import { TasksPage } from "./pages/TasksPage.js";
import { ReposPage } from "./pages/ReposPage.js";
import { AgentsPage } from "./pages/AgentsPage.js";
import { IssuesPage } from "./pages/IssuesPage.js";

function RequireAuth({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { token, role } = useAuth();
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  if (role !== "admin") {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/chat" element={<ChatPage />} />

        <Route path="/organization/business-units" element={<BusinessUnitsPage />} />
        <Route path="/organization/guided-setup" element={<GuidedSetupPage />} />
        <Route path="/organization/teams" element={<WorkspacePage />} />
        <Route path="/organization/skills-models" element={<SkillsModelsPage />} />

        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/issues" element={<IssuesPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/repos" element={<ReposPage />} />

        <Route path="/governance/approvals" element={<PlaceholderPage title="Approvals" />} />
        <Route path="/governance/email" element={<PlaceholderPage title="Email rules" />} />

        <Route path="/system/costs" element={<PlaceholderPage title="Costs & budgets" />} />
        <Route path="/system/audit" element={<PlaceholderPage title="Audit log" />} />

        <Route path="/company" element={<Navigate to="/organization/business-units" replace />} />
        <Route path="/workspace" element={<Navigate to="/organization/teams" replace />} />

        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <AdminPage />
            </RequireAdmin>
          }
        />
        <Route path="/projects/:projectId" element={<ProjectLayout />}>
          <Route index element={<Navigate to="intake" replace />} />
          <Route path="intake" element={<ProjectIntakeTab />} />
          <Route path="requirements" element={<ProjectRequirementsTab />} />
          <Route path="design" element={<ProjectDesignTab />} />
          <Route path="backlog" element={<ProjectBacklogTab />} />
          <Route path="sdm" element={<Navigate to="../backlog" replace />} />
          <Route path="plan" element={<ProjectPlanTab />} />
          <Route path="board" element={<ProjectBoardTab />} />
          <Route path="chat" element={<ProjectChatTab />} />
          <Route path="activity-log" element={<ProjectActivityLogTab />} />
          <Route path="sprints" element={<ProjectSprintsTab />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
