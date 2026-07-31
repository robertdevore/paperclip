import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { workspaceDiffQuerySchema } from "./contracts.js";
import { workspaceDiffService } from "./workspace-diff.js";

const PLUGIN_NAME = "workspace-diff";

const REVIEW_MARKER = /^<!-- paperclip-workspace-review:([\s\S]*?) -->\n?/;
const EMPTY_DIFF_SUMMARY = { additions: 0, deletions: 0, fileCount: 0 };

function reviewMarker(input: unknown) {
  if (typeof input !== "string") return null;
  const match = input.match(REVIEW_MARKER);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as { path?: unknown; line?: unknown; side?: unknown };
    if (typeof parsed.path !== "string" || typeof parsed.line !== "number" || !Number.isInteger(parsed.line) || parsed.line < 1) return null;
    return { path: parsed.path, line: parsed.line, side: parsed.side === "deletions" ? "deletions" as const : "additions" as const };
  } catch {
    return null;
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(value: unknown): string | null {
  const trimmed = readString(value);
  return trimmed || null;
}

export function resolveDefaultBaseRef(input: {
  workspaceBaseRef?: unknown;
  projectWorkspaceDefaultRef?: unknown;
  projectWorkspaceRepoRef?: unknown;
}): string | null {
  return readOptionalString(input.workspaceBaseRef)
    ?? readOptionalString(input.projectWorkspaceDefaultRef)
    ?? readOptionalString(input.projectWorkspaceRepoRef);
}

async function resolveProjectWorkspaceDefaultBaseRef(input: {
  ctx: PluginContext;
  projectId: string;
  companyId: string;
  projectWorkspaceId?: string | null;
}): Promise<string | null> {
  if (!input.projectId) return null;
  const workspaces = await input.ctx.projects.listWorkspaces(input.projectId, input.companyId);
  const projectWorkspace = input.projectWorkspaceId
    ? workspaces.find((candidate) => candidate.id === input.projectWorkspaceId)
    : workspaces.find((candidate) => candidate.isPrimary) ?? workspaces[0] ?? null;
  return projectWorkspace
    ? resolveDefaultBaseRef({
      projectWorkspaceDefaultRef: projectWorkspace.defaultRef,
      projectWorkspaceRepoRef: projectWorkspace.repoRef,
    })
    : null;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);
    const workspaceDiff = workspaceDiffService();

    ctx.data.register("workspace-diff", async (params: Record<string, unknown>) => {
      const workspaceId = readString(params.workspaceId);
      const companyId = readString(params.companyId);
      if (!workspaceId || !companyId) {
        throw new Error("workspaceId and companyId are required");
      }

      if (params.entityType === "project_workspace") {
        const projectId = readString(params.projectId);
        if (!projectId) {
          throw new Error("projectId is required for project workspace diffs");
        }
        const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
        const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
        if (!workspace) {
          throw new Error("Workspace not found");
        }
        return workspaceDiff.getDiff({
          id: workspace.id,
          companyId,
          cwd: workspace.path,
          baseRef: resolveDefaultBaseRef({
            projectWorkspaceDefaultRef: workspace.defaultRef,
            projectWorkspaceRepoRef: workspace.repoRef,
          }),
        }, workspaceDiffQuerySchema.parse(params));
      }

      const workspace = await ctx.executionWorkspaces.get(workspaceId, companyId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      let projectWorkspaceDefaultBaseRef: string | null = null;
      if (!readOptionalString(workspace.baseRef)) {
        projectWorkspaceDefaultBaseRef = await resolveProjectWorkspaceDefaultBaseRef({
          ctx,
          projectId: workspace.projectId || readString(params.projectId),
          companyId,
          projectWorkspaceId: workspace.projectWorkspaceId,
        });
      }

      return workspaceDiff.getDiff({
        ...workspace,
        baseRef: resolveDefaultBaseRef({
          workspaceBaseRef: workspace.baseRef,
          projectWorkspaceDefaultRef: projectWorkspaceDefaultBaseRef,
        }),
      }, workspaceDiffQuerySchema.parse(params));
    });

    ctx.data.register("comment-review-context", async (params: Record<string, unknown>) => {
      const issueId = readString(params.issueId);
      const companyId = readString(params.companyId);
      if (!issueId || !companyId) throw new Error("issueId and companyId are required");
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue) return { workspaceId: null, projectId: null, entityType: null };
      if (issue.executionWorkspaceId) {
        return {
          workspaceId: issue.executionWorkspaceId,
          projectId: issue.projectId ?? null,
          entityType: "execution_workspace",
        };
      }

      // Tasks created without an isolated execution workspace still have a
      // reviewable project workspace. Prefer its primary workspace so the
      // comment action remains useful for shared/local project runs.
      if (issue.projectId) {
        const workspaces = await ctx.projects.listWorkspaces(issue.projectId, companyId);
        const workspace = workspaces.find((candidate) => candidate.isPrimary) ?? workspaces[0] ?? null;
        if (workspace) {
          return {
            workspaceId: workspace.id,
            projectId: issue.projectId,
            entityType: "project_workspace",
          };
        }
      }

      return { workspaceId: null, projectId: issue.projectId ?? null, entityType: null };
    });

    ctx.data.register("comment-diff-summary", async (params: Record<string, unknown>) => {
      const issueId = readString(params.issueId);
      const companyId = readString(params.companyId);
      if (!issueId || !companyId) return EMPTY_DIFF_SUMMARY;
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue) return EMPTY_DIFF_SUMMARY;

      if (issue.executionWorkspaceId) {
        const workspace = await ctx.executionWorkspaces.get(issue.executionWorkspaceId, companyId);
        if (!workspace) return EMPTY_DIFF_SUMMARY;
        const diff = await workspaceDiff.getDiff(
          workspace,
          workspaceDiffQuerySchema.parse({ view: "working-tree", includeUntracked: false }),
        );
        return { additions: diff.stats.additions, deletions: diff.stats.deletions, fileCount: diff.stats.fileCount };
      }

      if (!issue.projectId) return EMPTY_DIFF_SUMMARY;
      const workspaces = await ctx.projects.listWorkspaces(issue.projectId, companyId);
      const workspace = workspaces.find((candidate) => candidate.isPrimary) ?? workspaces[0] ?? null;
      if (!workspace) return EMPTY_DIFF_SUMMARY;
      const diff = await workspaceDiff.getDiff(
        {
          id: workspace.id,
          companyId,
          cwd: workspace.path,
          baseRef: resolveDefaultBaseRef({
            projectWorkspaceDefaultRef: workspace.defaultRef,
            projectWorkspaceRepoRef: workspace.repoRef,
          }),
        },
        workspaceDiffQuerySchema.parse({ view: "working-tree", includeUntracked: false }),
      );
      return { additions: diff.stats.additions, deletions: diff.stats.deletions, fileCount: diff.stats.fileCount };
    });

    ctx.data.register("review-comments", async (params: Record<string, unknown>) => {
      const issueId = readString(params.issueId);
      const companyId = readString(params.companyId);
      if (!issueId || !companyId) throw new Error("issueId and companyId are required");
      const comments = await ctx.issues.listComments(issueId, companyId);
      return comments.flatMap((comment) => {
        const marker = reviewMarker(comment.body);
        if (!marker) return [];
        return [{ ...marker, id: comment.id, body: comment.body.replace(REVIEW_MARKER, "").trim(), createdAt: comment.createdAt }];
      });
    });

    ctx.actions.register("create-line-comment", async (params: Record<string, unknown>) => {
      const issueId = readString(params.issueId);
      const companyId = readString(params.companyId);
      const actorUserId = readString(params.actorUserId);
      const path = readString(params.path);
      const body = readString(params.body);
      const line = Number(params.line);
      const side = params.side === "deletions" ? "deletions" : "additions";
      if (!issueId || !companyId || !path || !body || !Number.isInteger(line) || line < 1) {
        throw new Error("issueId, companyId, path, line, and body are required");
      }
      return ctx.issues.createComment(
        issueId,
        `<!-- paperclip-workspace-review:${JSON.stringify({ path, line, side })} -->\n${body}`,
        companyId,
        actorUserId ? { actorUserId } : undefined,
      );
    });
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
