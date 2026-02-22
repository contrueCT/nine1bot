import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import { Session } from "../../session"
import { Storage } from "../../storage/storage"
import { ProjectEnvironment } from "../../project/environment"
import { ProjectSharedFiles } from "../../project/shared-files"
import z from "zod"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const ProjectRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List all projects",
        description: "Get a list of projects that have been opened with OpenCode.",
        operationId: "project.list",
        responses: {
          200: {
            description: "List of projects",
            content: {
              "application/json": {
                schema: resolver(Project.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const projects = await Project.list()
        return c.json(projects)
      },
    )
    .get(
      "/current",
      describeRoute({
        summary: "Get current project",
        description: "Retrieve the currently active project that OpenCode is working with.",
        operationId: "project.current",
        responses: {
          200: {
            description: "Current project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional(),
        }),
      ),
      async (c) => {
        const { directory } = c.req.valid("query")
        if (directory) {
          const discovered = await Project.fromDirectory(directory)
          return c.json(discovered.project)
        }
        return c.json(Instance.project)
      },
    )
    .get(
      "/:projectID",
      describeRoute({
        summary: "Get project",
        description: "Get one project by ID.",
        operationId: "project.get",
        responses: {
          200: {
            description: "Project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      async (c) => {
        const { projectID } = c.req.valid("param")
        const project = await Project.get(projectID)
        return c.json(project)
      },
    )
    .get(
      "/:projectID/session",
      describeRoute({
        summary: "List project sessions",
        description: "Get all sessions for a specific project.",
        operationId: "project.sessions",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      validator(
        "query",
        z.object({
          roots: z.coerce.boolean().optional(),
          start: z.coerce.number().optional(),
          search: z.string().optional(),
          limit: z.coerce.number().optional(),
        }),
      ),
      async (c) => {
        const { projectID } = c.req.valid("param")
        const query = c.req.valid("query")

        // Ensure project exists
        await Project.get(projectID)

        const keys = await Storage.list(["session", projectID])
        const sessions: Session.Info[] = []
        for (const key of keys) {
          const session = await Storage.read<Session.Info>(key).catch(() => undefined)
          if (!session) continue
          if (query.roots && session.parentID) continue
          if (query.start !== undefined && session.time.updated < query.start) continue
          if (query.search && !session.title.toLowerCase().includes(query.search.toLowerCase())) continue
          sessions.push(session)
        }

        sessions.sort((a, b) => b.time.updated - a.time.updated)
        if (query.limit !== undefined) {
          return c.json(sessions.slice(0, query.limit))
        }
        return c.json(sessions)
      },
    )
    .post(
      "/:projectID/forget",
      describeRoute({
        summary: "Forget project",
        description: "Hide project from the list without deleting project files.",
        operationId: "project.forget",
        responses: {
          200: {
            description: "Project forgotten",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      async (c) => {
        const { projectID } = c.req.valid("param")
        await Project.get(projectID)
        await Project.forget(projectID)
        return c.json(true)
      },
    )
    .get(
      "/:projectID/environment",
      describeRoute({
        summary: "Get project environment variables",
        description: "Get environment variables for a specific project.",
        operationId: "project.environment.get",
        responses: {
          200: {
            description: "Project environment variables",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    keys: z.array(z.string()),
                    variables: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      async (c) => {
        const { projectID } = c.req.valid("param")
        await Project.get(projectID)
        const variables = await ProjectEnvironment.getAll(projectID)
        return c.json({
          keys: Object.keys(variables).sort(),
          variables,
        })
      },
    )
    .put(
      "/:projectID/environment",
      describeRoute({
        summary: "Replace project environment variables",
        description: "Replace all environment variables for a project.",
        operationId: "project.environment.replace",
        responses: {
          200: {
            description: "Updated environment variables",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.string())),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      validator("json", z.object({ variables: z.record(z.string(), z.string()) })),
      async (c) => {
        const { projectID } = c.req.valid("param")
        const body = c.req.valid("json")
        await Project.get(projectID)
        const variables = await ProjectEnvironment.setAll(projectID, body.variables)
        await Project.markContextChanged(projectID, ["environment"])
        return c.json(variables)
      },
    )
    .patch(
      "/:projectID/environment/:key",
      describeRoute({
        summary: "Set project environment variable",
        description: "Set or update a single project environment variable.",
        operationId: "project.environment.patch",
        responses: {
          200: {
            description: "Updated environment variables",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.string())),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string(), key: z.string() })),
      validator("json", z.object({ value: z.string() })),
      async (c) => {
        const { projectID, key } = c.req.valid("param")
        const body = c.req.valid("json")
        await Project.get(projectID)
        const variables = await ProjectEnvironment.set(projectID, key, body.value)
        await Project.markContextChanged(projectID, ["environment"])
        return c.json(variables)
      },
    )
    .delete(
      "/:projectID/environment/:key",
      describeRoute({
        summary: "Delete project environment variable",
        description: "Delete one environment variable from a project.",
        operationId: "project.environment.delete",
        responses: {
          200: {
            description: "Updated environment variables",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.string())),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string(), key: z.string() })),
      async (c) => {
        const { projectID, key } = c.req.valid("param")
        await Project.get(projectID)
        const variables = await ProjectEnvironment.remove(projectID, key)
        await Project.markContextChanged(projectID, ["environment"])
        return c.json(variables)
      },
    )
    .get(
      "/:projectID/shared-files",
      describeRoute({
        summary: "List project shared files",
        description: "List files in .nine1bot/projectfiles for a project.",
        operationId: "project.sharedFiles.list",
        responses: {
          200: {
            description: "Shared files",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      name: z.string(),
                      relativePath: z.string(),
                      size: z.number(),
                      modified: z.number(),
                      mime: z.string().optional(),
                    }),
                  ),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      async (c) => {
        const { projectID } = c.req.valid("param")
        const project = await Project.get(projectID)
        const files = await ProjectSharedFiles.list(project.rootDirectory)
        return c.json(files)
      },
    )
    .post(
      "/:projectID/shared-files",
      describeRoute({
        summary: "Upload project shared file",
        description: "Upload a file into .nine1bot/projectfiles for a project.",
        operationId: "project.sharedFiles.upload",
        responses: {
          200: {
            description: "Uploaded file info",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    name: z.string(),
                    relativePath: z.string(),
                    size: z.number(),
                    modified: z.number(),
                    mime: z.string().optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      validator(
        "json",
        z.object({
          filename: z.string(),
          url: z.string(),
          mime: z.string().optional(),
        }),
      ),
      async (c) => {
        const { projectID } = c.req.valid("param")
        const body = c.req.valid("json")
        const project = await Project.get(projectID)
        const file = await ProjectSharedFiles.save(project.rootDirectory, body)
        await Project.markContextChanged(projectID, ["shared_files"])
        return c.json(file)
      },
    )
    .delete(
      "/:projectID/shared-files",
      describeRoute({
        summary: "Delete project shared file",
        description: "Delete a file from .nine1bot/projectfiles for a project.",
        operationId: "project.sharedFiles.delete",
        responses: {
          200: {
            description: "Deleted",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      validator(
        "json",
        z.object({
          relativePath: z.string(),
        }),
      ),
      async (c) => {
        const { projectID } = c.req.valid("param")
        const body = c.req.valid("json")
        const project = await Project.get(projectID)
        await ProjectSharedFiles.remove(project.rootDirectory, body.relativePath)
        await Project.markContextChanged(projectID, ["shared_files"])
        return c.json(true)
      },
    )
    .patch(
      "/:projectID",
      describeRoute({
        summary: "Update project",
        description: "Update project properties such as name, icon, and commands.",
        operationId: "project.update",
        responses: {
          200: {
            description: "Updated project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      validator("json", Project.update.schema.omit({ projectID: true })),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        const body = c.req.valid("json")
        const project = await Project.update({ ...body, projectID })
        return c.json(project)
      },
    ),
)
