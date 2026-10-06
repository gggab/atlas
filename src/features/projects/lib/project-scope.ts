// Local project registry. All projects and groups are visible without an account.
import { useProjectStore, type Project, type ProjectGroup } from "../stores/project-store";
export function useLocalProjects(): Project[] {
  return useProjectStore.use.projects();
}
export function useLocalGroups(): ProjectGroup[] {
  return useProjectStore.use.groups();
}
export function localProjectsSnapshot(): Project[] {
  return useProjectStore.getState().projects;
}
