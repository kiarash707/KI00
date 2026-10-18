import { Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import Layout from "./components/Layout";
import { Loading } from "./components/ui";
import { useSession } from "./lib/session";
import Auth from "./pages/Auth";
import Overview from "./pages/Overview";
import Projects from "./pages/Projects";
import NewProject from "./pages/NewProject";
import ProjectDetail from "./pages/ProjectDetail";
import Deployments from "./pages/Deployments";
import DeploymentDetail from "./pages/DeploymentDetail";
import ActivityPage from "./pages/Activity";
import Agent from "./pages/Agent";
import SettingsPage from "./pages/Settings";
import NotFound from "./pages/NotFound";

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <Loading label="Starting KI00" />
      </div>
    );
  }
  if (!session?.authenticated) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Auth />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Overview />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/new" element={<NewProject />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/projects/:id/:tab" element={<ProjectDetail />} />
        <Route path="/deployments" element={<Deployments />} />
        <Route path="/deployments/:id" element={<DeploymentDetail />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/agent" element={<Agent />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
