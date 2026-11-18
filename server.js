"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");

const scrypt = promisify(crypto.scrypt);
const root = __dirname;
const port = Number(process.env.PORT || 3000);
const databasePath = path.resolve(process.env.TEAMFLOW_DB || path.join(root, "data", "teamflow.sqlite"));
const sessionDays = 7;
const sessionCookie = "teamflow_session";
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('owner', 'member')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(workspace_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS workspace_invitations (
    token_hash TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    color TEXT NOT NULL DEFAULT 'purple',
    deadline TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    due_date TEXT,
    status TEXT NOT NULL CHECK(status IN ('To do', 'In progress')),
    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("users", "default_workspace_id", "TEXT");
ensureColumn("sessions", "workspace_id", "TEXT");
ensureColumn("projects", "workspace_id", "TEXT REFERENCES workspaces(id) ON DELETE CASCADE");
ensureColumn("tasks", "workspace_id", "TEXT REFERENCES workspaces(id) ON DELETE CASCADE");
ensureColumn("tasks", "assignee_name", "TEXT");

db.exec(`
  CREATE TABLE IF NOT EXISTS task_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS task_comments_task_idx ON task_comments(task_id, created_at);
`);

const insertWorkspace = db.prepare("INSERT INTO workspaces (id, name, owner_id) VALUES (?, ?, ?)");
const insertWorkspaceMember = db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)");
const updateDefaultWorkspace = db.prepare("UPDATE users SET default_workspace_id = ? WHERE id = ?");
for (const user of db.prepare(`
  SELECT users.id, users.name
  FROM users LEFT JOIN workspace_members ON workspace_members.user_id = users.id
  GROUP BY users.id HAVING COUNT(workspace_members.workspace_id) = 0
`).all()) {
  const workspaceId = crypto.randomUUID();
  insertWorkspace.run(workspaceId, `${user.name}'s workspace`, user.id);
  insertWorkspaceMember.run(workspaceId, user.id, "owner");
  updateDefaultWorkspace.run(workspaceId, user.id);
}
db.exec(`
  UPDATE users SET default_workspace_id = (
    SELECT workspace_id FROM workspace_members WHERE user_id = users.id ORDER BY created_at LIMIT 1
  ) WHERE default_workspace_id IS NULL;
  UPDATE projects SET workspace_id = (
    SELECT workspace_id FROM workspace_members WHERE user_id = projects.user_id ORDER BY created_at LIMIT 1
  ) WHERE workspace_id IS NULL;
  UPDATE tasks SET workspace_id = (
    SELECT workspace_id FROM workspace_members WHERE user_id = tasks.user_id ORDER BY created_at LIMIT 1
  ) WHERE workspace_id IS NULL;
  UPDATE sessions SET workspace_id = (
    SELECT default_workspace_id FROM users WHERE users.id = sessions.user_id
  ) WHERE workspace_id IS NULL;
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id);
  CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects(workspace_id);
  CREATE INDEX IF NOT EXISTS tasks_workspace_due_idx ON tasks(workspace_id, due_date);
  CREATE INDEX IF NOT EXISTS invitations_expiry_idx ON workspace_invitations(expires_at);
`);

const statements = {
  userByEmail: db.prepare("SELECT id, name, email, password_hash, password_salt, default_workspace_id FROM users WHERE email = ?"),
  insertUser: db.prepare("INSERT INTO users (id, name, email, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)"),
  insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, workspace_id, expires_at) VALUES (?, ?, ?, ?)"),
  sessionUser: db.prepare(`
    SELECT users.id, users.name, users.email, sessions.workspace_id, workspaces.name AS workspace_name,
      workspace_members.role AS workspace_role
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    JOIN workspaces ON workspaces.id = sessions.workspace_id
    JOIN workspace_members ON workspace_members.workspace_id = sessions.workspace_id AND workspace_members.user_id = users.id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  insertWorkspace: db.prepare("INSERT INTO workspaces (id, name, owner_id) VALUES (?, ?, ?)"),
  insertWorkspaceMember: db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)"),
  workspaceByInvite: db.prepare("SELECT workspace_id FROM workspace_invitations WHERE token_hash = ? AND expires_at > ?"),
  insertInvitation: db.prepare("INSERT INTO workspace_invitations (token_hash, workspace_id, created_by, expires_at) VALUES (?, ?, ?, ?)"),
  listWorkspaces: db.prepare(`
    SELECT workspaces.id, workspaces.name, workspace_members.role,
      (SELECT COUNT(*) FROM workspace_members AS members WHERE members.workspace_id = workspaces.id) AS member_count
    FROM workspace_members JOIN workspaces ON workspaces.id = workspace_members.workspace_id
    WHERE workspace_members.user_id = ?
    ORDER BY workspace_members.created_at
  `),
  workspaceMembership: db.prepare("SELECT workspace_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?"),
  updateSessionWorkspace: db.prepare("UPDATE sessions SET workspace_id = ? WHERE token_hash = ? AND user_id = ?"),
  updateUserWorkspace: db.prepare("UPDATE users SET default_workspace_id = ? WHERE id = ?"),
  listProjects: db.prepare(`
    SELECT projects.id, projects.name, projects.category, projects.color, projects.deadline,
      COUNT(tasks.id) AS task_count,
      SUM(CASE WHEN tasks.completed = 1 THEN 1 ELSE 0 END) AS completed_count
    FROM projects LEFT JOIN tasks ON tasks.project_id = projects.id
    WHERE projects.workspace_id = ?
    GROUP BY projects.id
    ORDER BY projects.created_at, projects.name
  `),
  projectById: db.prepare("SELECT id, name, category, color, deadline FROM projects WHERE id = ? AND workspace_id = ?"),
  insertProject: db.prepare("INSERT INTO projects (id, user_id, workspace_id, name, category, color, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  updateProject: db.prepare("UPDATE projects SET name = ?, category = ?, color = ?, deadline = ? WHERE id = ? AND workspace_id = ?"),
  deleteProject: db.prepare("DELETE FROM projects WHERE id = ? AND workspace_id = ?"),
  listTasks: db.prepare(`
    SELECT tasks.id, tasks.title, tasks.project_id, projects.name AS project,
      tasks.due_date, tasks.status, tasks.completed, tasks.assignee_name,
      (SELECT COUNT(*) FROM task_comments WHERE task_comments.task_id = tasks.id) AS comment_count,
      tasks.created_at, tasks.updated_at
    FROM tasks JOIN projects ON projects.id = tasks.project_id
    WHERE tasks.workspace_id = ?
    ORDER BY tasks.completed ASC, tasks.due_date IS NULL, tasks.due_date, tasks.created_at DESC
  `),
  taskById: db.prepare(`
    SELECT id, title, project_id, due_date, status, completed, assignee_name, created_at, updated_at
    FROM tasks WHERE id = ? AND workspace_id = ?
  `),
  insertTask: db.prepare(`
    INSERT INTO tasks (id, user_id, workspace_id, project_id, title, due_date, status, completed, assignee_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateTask: db.prepare(`
    UPDATE tasks SET project_id = ?, title = ?, due_date = ?, status = ?, completed = ?, assignee_name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND workspace_id = ?
  `),
  deleteTask: db.prepare("DELETE FROM tasks WHERE id = ? AND workspace_id = ?"),
  listComments: db.prepare("SELECT id, task_id, user_id, author_name, content, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at ASC"),
  insertComment: db.prepare("INSERT INTO task_comments (id, task_id, user_id, author_name, content) VALUES (?, ?, ?, ?, ?)")
};

function sendJson(response, status, data, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  response.end(JSON.stringify(data));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function requestPath(request) {
  return new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 16_384) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie || "";
  const prefix = `${name}=`;
  const item = cookies.split(";").map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : "";
}

function hashSession(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sessionCookieHeader(token, maxAge = sessionDays * 24 * 60 * 60) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

async function createSession(userId, workspaceId, response) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionDays * 24 * 60 * 60 * 1000;
  statements.deleteExpiredSessions.run(Date.now());
  statements.insertSession.run(hashSession(token), userId, workspaceId, expiresAt);
  response.setHeader("Set-Cookie", sessionCookieHeader(token));
}

function getAuthenticatedUser(request) {
  const token = cookieValue(request, sessionCookie);
  if (!token) return null;
  return statements.sessionUser.get(hashSession(token), Date.now()) || null;
}

function validDate(value) {
  if (value === null || value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function getProjectForWorkspace(projectId, workspaceId) {
  return statements.projectById.get(projectId, workspaceId) || null;
}

function mapProject(project) {
  const taskCount = Number(project.task_count || 0);
  const completedCount = Number(project.completed_count || 0);
  return {
    id: project.id,
    name: project.name,
    category: project.category,
    color: project.color,
    deadline: project.deadline,
    task_count: taskCount,
    completed_count: completedCount,
    progress: taskCount ? Math.round((completedCount / taskCount) * 100) : 0
  };
}

function seedWorkspace(userId, workspaceId) {
  const projects = [
    { id: crypto.randomUUID(), name: "Website redesign", category: "Design", color: "purple", offset: 7 },
    { id: crypto.randomUUID(), name: "Mobile app", category: "Product", color: "orange", offset: 14 },
    { id: crypto.randomUUID(), name: "Brand refresh", category: "Marketing", color: "green", offset: 21 }
  ];
  const dateOffset = (days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  for (const project of projects) {
    statements.insertProject.run(project.id, userId, workspaceId, project.name, project.category, project.color, dateOffset(project.offset));
  }
  const samples = [
    ["Finalize homepage wireframes", projects[0].id, 0, "In progress", "Jordan Davis"],
    ["Review Q4 campaign brief", projects[2].id, 0, "To do", "Alex Lee"],
    ["Update component library", projects[0].id, 2, "In progress", "Jordan Davis"],
    ["Share onboarding feedback", projects[1].id, 3, "To do", "Ashu"],
    ["Prepare sprint planning notes", projects[1].id, 4, "In progress", "Ashu"]
  ];
  for (const [title, projectId, offset, status, assignee] of samples) {
    const taskId = crypto.randomUUID();
    statements.insertTask.run(taskId, userId, workspaceId, projectId, title, dateOffset(offset), status, 0, assignee);
    if (title.startsWith("Finalize")) {
      statements.insertComment.run(crypto.randomUUID(), taskId, userId, "Jordan Davis", "Wireframe v2 is almost ready for client review!");
    }
  }
}

async function handleApi(request, response, pathname) {
  if (request.method === "POST" && pathname === "/api/auth/register") {
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const inviteCode = typeof body.invite_code === "string" ? body.invite_code.trim() : "";
    if (name.length < 2 || name.length > 80) return sendError(response, 400, "Name must be between 2 and 80 characters.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return sendError(response, 400, "Enter a valid email address.");
    if (password.length < 10 || password.length > 128) return sendError(response, 400, "Password must be between 10 and 128 characters.");
    if (statements.userByEmail.get(email)) return sendError(response, 409, "An account with that email already exists.");
    const invitation = inviteCode
      ? statements.workspaceByInvite.get(hashSession(inviteCode), Date.now())
      : null;
    if (inviteCode && !invitation) return sendError(response, 400, "That workspace invitation is invalid or has expired.");

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const user = { id: crypto.randomUUID(), name, email };
    const workspaceId = invitation ? invitation.workspace_id : crypto.randomUUID();
    db.exec("BEGIN");
    try {
      statements.insertUser.run(user.id, name, email, passwordHash.toString("hex"), salt);
      if (invitation) {
        statements.insertWorkspaceMember.run(workspaceId, user.id, "member");
      } else {
        statements.insertWorkspace.run(workspaceId, `${name}'s workspace`, user.id);
        statements.insertWorkspaceMember.run(workspaceId, user.id, "owner");
        seedWorkspace(user.id, workspaceId);
      }
      statements.updateUserWorkspace.run(workspaceId, user.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE") return sendError(response, 409, "An account with that email already exists.");
      throw error;
    }
    await createSession(user.id, workspaceId, response);
    return sendJson(response, 201, { user });
  }

  if (request.method === "POST" && pathname === "/api/auth/login") {
    const body = await readJson(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const user = statements.userByEmail.get(email);
    if (!user || !password) return sendError(response, 401, "Email or password is incorrect.");
    const supplied = await scrypt(password, user.password_salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const expected = Buffer.from(user.password_hash, "hex");
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return sendError(response, 401, "Email or password is incorrect.");
    }
    const workspaceId = user.default_workspace_id || statements.listWorkspaces.all(user.id)[0]?.id;
    if (!workspaceId) return sendError(response, 403, "Your account is not a member of a workspace.");
    await createSession(user.id, workspaceId, response);
    return sendJson(response, 200, { user: publicUser(user) });
  }

  const user = getAuthenticatedUser(request);
  if (request.method === "GET" && pathname === "/api/auth/me") {
    return sendJson(response, 200, { user: user ? publicUser(user) : null });
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const token = cookieValue(request, sessionCookie);
    if (token) statements.deleteSession.run(hashSession(token));
    return sendJson(response, 200, { success: true }, { "Set-Cookie": clearSessionCookie() });
  }

  if (!user) return sendError(response, 401, "Sign in to continue.");

  if (request.method === "GET" && pathname === "/api/workspaces") {
    return sendJson(response, 200, {
      workspaces: statements.listWorkspaces.all(user.id),
      active_workspace_id: user.workspace_id
    });
  }

  if (request.method === "POST" && pathname === "/api/workspaces/invitations") {
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    statements.insertInvitation.run(hashSession(token), user.workspace_id, user.id, expiresAt);
    return sendJson(response, 201, { code: token, expires_at: expiresAt });
  }

  if (request.method === "POST" && pathname === "/api/workspaces/join") {
    const body = await readJson(request);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const invitation = code ? statements.workspaceByInvite.get(hashSession(code), Date.now()) : null;
    if (!invitation) return sendError(response, 400, "That workspace invitation is invalid or has expired.");
    statements.insertWorkspaceMember.run(invitation.workspace_id, user.id, "member");
    const sessionToken = cookieValue(request, sessionCookie);
    statements.updateSessionWorkspace.run(invitation.workspace_id, hashSession(sessionToken), user.id);
    statements.updateUserWorkspace.run(invitation.workspace_id, user.id);
    return sendJson(response, 200, { success: true });
  }

  if (request.method === "PATCH" && pathname === "/api/workspaces/active") {
    const body = await readJson(request);
    const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : "";
    if (!statements.workspaceMembership.get(workspaceId, user.id)) return sendError(response, 404, "Workspace not found.");
    const sessionToken = cookieValue(request, sessionCookie);
    statements.updateSessionWorkspace.run(workspaceId, hashSession(sessionToken), user.id);
    statements.updateUserWorkspace.run(workspaceId, user.id);
    return sendJson(response, 200, { success: true });
  }

  if (request.method === "GET" && pathname === "/api/projects") {
    return sendJson(response, 200, { projects: statements.listProjects.all(user.workspace_id).map(mapProject) });
  }

  if (request.method === "POST" && pathname === "/api/projects") {
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const category = typeof body.category === "string" && body.category.trim() ? body.category.trim() : "General";
    const color = ["purple", "orange", "green"].includes(body.color) ? body.color : "purple";
    const deadline = body.deadline || null;
    if (name.length < 2 || name.length > 100) return sendError(response, 400, "Project name must be between 2 and 100 characters.");
    if (category.length > 60) return sendError(response, 400, "Project category must be 60 characters or fewer.");
    if (!validDate(deadline)) return sendError(response, 400, "Enter a valid project deadline.");
    const id = crypto.randomUUID();
    try {
      statements.insertProject.run(id, user.id, user.workspace_id, name, category, color, deadline || null);
    } catch (error) {
      if (error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE") return sendError(response, 409, "A project with that name already exists.");
      throw error;
    }
    return sendJson(response, 201, { project: mapProject({ id, name, category, color, deadline, task_count: 0, completed_count: 0 }) });
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([0-9a-f-]{36})$/i);
  if (projectMatch && request.method === "PATCH") {
    const project = getProjectForWorkspace(projectMatch[1], user.workspace_id);
    if (!project) return sendError(response, 404, "Project not found.");
    const body = await readJson(request);
    const name = body.name === undefined ? project.name : typeof body.name === "string" ? body.name.trim() : "";
    const category = body.category === undefined ? project.category : typeof body.category === "string" ? body.category.trim() : "";
    const color = body.color === undefined ? project.color : body.color;
    const deadline = body.deadline === undefined ? project.deadline : body.deadline;
    if (name.length < 2 || name.length > 100) return sendError(response, 400, "Project name must be between 2 and 100 characters.");
    if (!category || category.length > 60) return sendError(response, 400, "Project category must be between 1 and 60 characters.");
    if (!["purple", "orange", "green"].includes(color)) return sendError(response, 400, "Choose a valid project color.");
    if (!validDate(deadline)) return sendError(response, 400, "Enter a valid project deadline.");
    try {
      statements.updateProject.run(name, category, color, deadline || null, project.id, user.workspace_id);
    } catch (error) {
      if (error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE") return sendError(response, 409, "A project with that name already exists.");
      throw error;
    }
    return sendJson(response, 200, { project: { ...project, name, category, color, deadline: deadline || null } });
  }
  if (projectMatch && request.method === "DELETE") {
    const result = statements.deleteProject.run(projectMatch[1], user.workspace_id);
    return result.changes ? sendJson(response, 200, { success: true }) : sendError(response, 404, "Project not found.");
  }

  if (request.method === "GET" && pathname === "/api/tasks") {
    return sendJson(response, 200, { tasks: statements.listTasks.all(user.workspace_id).map((task) => ({ ...task, completed: Boolean(task.completed) })) });
  }

  if (request.method === "POST" && pathname === "/api/tasks") {
    const body = await readJson(request);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const projectId = typeof body.project_id === "string" ? body.project_id : "";
    const status = body.status;
    const dueDate = body.due_date || null;
    const assigneeName = typeof body.assignee_name === "string" && body.assignee_name.trim() ? body.assignee_name.trim() : "Unassigned";
    if (title.length < 1 || title.length > 200) return sendError(response, 400, "Task title must be between 1 and 200 characters.");
    if (!getProjectForWorkspace(projectId, user.workspace_id)) return sendError(response, 400, "Choose a project in your workspace.");
    if (!["To do", "In progress"].includes(status)) return sendError(response, 400, "Choose a valid task status.");
    if (!validDate(dueDate)) return sendError(response, 400, "Enter a valid task due date.");
    const id = crypto.randomUUID();
    statements.insertTask.run(id, user.id, user.workspace_id, projectId, title, dueDate || null, status, 0, assigneeName);
    const task = statements.listTasks.all(user.workspace_id).find((item) => item.id === id);
    return sendJson(response, 201, { task: { ...task, completed: Boolean(task.completed) } });
  }

  const commentsMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})\/comments$/i);
  if (commentsMatch && request.method === "GET") {
    const task = statements.taskById.get(commentsMatch[1], user.workspace_id);
    if (!task) return sendError(response, 404, "Task not found.");
    const comments = statements.listComments.all(task.id);
    return sendJson(response, 200, { comments });
  }
  if (commentsMatch && request.method === "POST") {
    const task = statements.taskById.get(commentsMatch[1], user.workspace_id);
    if (!task) return sendError(response, 404, "Task not found.");
    const body = await readJson(request);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content || content.length > 1000) return sendError(response, 400, "Comment must be between 1 and 1000 characters.");
    const id = crypto.randomUUID();
    statements.insertComment.run(id, task.id, user.id, user.name, content);
    return sendJson(response, 201, { comment: { id, task_id: task.id, user_id: user.id, author_name: user.name, content, created_at: new Date().toISOString() } });
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})$/i);
  if (taskMatch && request.method === "PATCH") {
    const task = statements.taskById.get(taskMatch[1], user.workspace_id);
    if (!task) return sendError(response, 404, "Task not found.");
    const body = await readJson(request);
    const title = body.title === undefined ? task.title : typeof body.title === "string" ? body.title.trim() : "";
    const projectId = body.project_id === undefined ? task.project_id : body.project_id;
    const dueDate = body.due_date === undefined ? task.due_date : body.due_date;
    const status = body.status === undefined ? task.status : body.status;
    const completed = body.completed === undefined ? Boolean(task.completed) : body.completed;
    const assigneeName = body.assignee_name === undefined ? (task.assignee_name || "Unassigned") : typeof body.assignee_name === "string" ? body.assignee_name.trim() : "Unassigned";
    if (title.length < 1 || title.length > 200) return sendError(response, 400, "Task title must be between 1 and 200 characters.");
    if (!getProjectForWorkspace(projectId, user.workspace_id)) return sendError(response, 400, "Choose a project in your workspace.");
    if (!["To do", "In progress"].includes(status)) return sendError(response, 400, "Choose a valid task status.");
    if (typeof completed !== "boolean") return sendError(response, 400, "Task completion must be true or false.");
    if (!validDate(dueDate)) return sendError(response, 400, "Enter a valid task due date.");
    statements.updateTask.run(projectId, title, dueDate || null, status, Number(completed), assigneeName, task.id, user.workspace_id);
    const updatedTask = statements.listTasks.all(user.workspace_id).find((item) => item.id === task.id);
    return sendJson(response, 200, { task: { ...updatedTask, completed: Boolean(updatedTask.completed) } });
  }
  if (taskMatch && request.method === "DELETE") {
    const result = statements.deleteTask.run(taskMatch[1], user.workspace_id);
    return result.changes ? sendJson(response, 200, { success: true }) : sendError(response, 404, "Task not found.");
  }

  return sendError(response, 404, "API route not found.");
}

function serveStatic(request, response, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(root, `.${decodeURIComponent(requestedPath)}`);
  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== path.join(root, "index.html")) {
    return sendError(response, 404, "File not found.");
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendError(response, 404, "File not found.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": [".html", ".css", ".js"].includes(path.extname(filePath)) ? "no-cache" : "public, max-age=3600"
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = requestPath(request);
    if (pathname.startsWith("/api/")) {
      await handleApi(request, response, pathname);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendError(response, 405, "Method not allowed.");
      return;
    }
    serveStatic(request, response, pathname);
  } catch (error) {
    if (error.status) {
      sendError(response, error.status, error.message);
      return;
    }
    console.error("TeamFlow request failed.", error);
    if (!response.headersSent) sendError(response, 500, "Something went wrong. Please try again.");
    else response.destroy();
  }
});

server.listen(port, () => {
  console.log(`TeamFlow is running at http://localhost:${port}`);
  console.log(`Database: ${databasePath}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
