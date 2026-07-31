import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.workspace-diff";
const CHANGES_TAB_SLOT_ID = "workspace-changes-tab";
const REVIEW_CHANGES_LAUNCHER_ID = "review-comment-changes";
const REVIEW_CHANGES_MODAL = "WorkspaceDiffReviewModal";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Workspace Changes",
  description: "Adds a Changes tab to execution and project workspaces using plugin-local Git diff computation and @pierre/diffs.",
  author: "Paperclip",
  categories: ["workspace", "ui"],
  capabilities: [
    "ui.detailTab.register",
    "ui.action.register",
    "issues.read",
    "issue.comments.read",
    "issue.comments.create",
    "issue.comments.create_human_attributed",
    "execution.workspaces.read",
    "project.workspaces.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "detailTab",
        id: CHANGES_TAB_SLOT_ID,
        displayName: "Changes",
        exportName: "ChangesTab",
        entityTypes: ["execution_workspace", "project_workspace"],
        order: 25,
      },
    ],
    launchers: [
      {
        id: REVIEW_CHANGES_LAUNCHER_ID,
        displayName: "Review workspace changes",
        description: "Open the agent workspace diff with line-by-line review comments.",
        placementZone: "commentContextMenuItem",
        entityTypes: ["comment"],
        action: { type: "openModal", target: REVIEW_CHANGES_MODAL },
        render: {
          environment: "hostOverlay",
          bounds: "full",
          trigger: { type: "diffSummary", dataKey: "comment-diff-summary" },
        },
      },
    ],
  },
};

export default manifest;
