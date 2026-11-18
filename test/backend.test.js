"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer(port, databasePath) {
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), TEAMFLOW_DB: databasePath },
    stdio: "ignore"
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`TeamFlow server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.status === 200) return { child, baseUrl };
    } catch {
      await delay(50);
    }
  }
  child.kill();
  throw new Error("TeamFlow server did not start in time.");
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

async function request(baseUrl, method, endpoint, body, cookie) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  const setCookie = response.headers.get("set-cookie");
  return {
    status: response.status,
    data,
    cookie: setCookie ? setCookie.split(";")[0] : cookie
  };
}

test("accounts own persistent projects and tasks through the authenticated API", { timeout: 30_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "teamflow-test-"));
  const databasePath = path.join(directory, "teamflow.sqlite");
  const port = await freePort();
  let server = await startServer(port, databasePath);
  t.after(async () => {
    await stopServer(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const { baseUrl } = server;
  const registration = await request(baseUrl, "POST", "/api/auth/register", {
    name: "Jordan Davis",
    email: "jordan@example.com",
    password: "safe-test-password"
  });
  assert.equal(registration.status, 201);
  assert.equal(registration.data.user.email, "jordan@example.com");
  assert.match(registration.cookie, /^teamflow_session=/);

  const duplicate = await request(baseUrl, "POST", "/api/auth/register", {
    name: "Jordan Davis",
    email: "JORDAN@example.com",
    password: "safe-test-password"
  });
  assert.equal(duplicate.status, 409);

  const badLogin = await request(baseUrl, "POST", "/api/auth/login", {
    email: "jordan@example.com",
    password: "incorrect-password"
  });
  assert.equal(badLogin.status, 401);

  const initialProjects = await request(baseUrl, "GET", "/api/projects", undefined, registration.cookie);
  assert.equal(initialProjects.status, 200);
  assert.equal(initialProjects.data.projects.length, 3);
  const taskList = await request(baseUrl, "GET", "/api/tasks", undefined, registration.cookie);
  assert.equal(taskList.data.tasks.length, 5);

  const newProject = await request(baseUrl, "POST", "/api/projects", {
    name: "Private launch",
    category: "Product",
    color: "green"
  }, registration.cookie);
  assert.equal(newProject.status, 201);

  const newTask = await request(baseUrl, "POST", "/api/tasks", {
    title: "Ship the first milestone",
    project_id: newProject.data.project.id,
    due_date: "2026-11-01",
    status: "To do",
    assignee_name: "Ashu"
  }, registration.cookie);
  assert.equal(newTask.status, 201);
  assert.equal(newTask.data.task.assignee_name, "Ashu");

  const newComment = await request(baseUrl, "POST", `/api/tasks/${newTask.data.task.id}/comments`, {
    content: "Working on the final checks for this milestone!"
  }, registration.cookie);
  assert.equal(newComment.status, 201);
  assert.equal(newComment.data.comment.author_name, "Jordan Davis");

  const commentsList = await request(baseUrl, "GET", `/api/tasks/${newTask.data.task.id}/comments`, undefined, registration.cookie);
  assert.equal(commentsList.status, 200);
  assert.equal(commentsList.data.comments.length, 1);
  assert.equal(commentsList.data.comments[0].content, "Working on the final checks for this milestone!");

  const invalidTask = await request(baseUrl, "POST", "/api/tasks", {
    title: "Bad date",
    project_id: newProject.data.project.id,
    due_date: "2026-02-31",
    status: "To do"
  }, registration.cookie);
  assert.equal(invalidTask.status, 400);

  const updatedTask = await request(baseUrl, "PATCH", `/api/tasks/${newTask.data.task.id}`, {
    status: "In progress",
    completed: true
  }, registration.cookie);
  assert.equal(updatedTask.status, 200);
  assert.equal(updatedTask.data.task.completed, true);
  assert.equal(updatedTask.data.task.title, "Ship the first milestone");

  const secondRegistration = await request(baseUrl, "POST", "/api/auth/register", {
    name: "Alex Lee",
    email: "alex@example.com",
    password: "another-safe-password"
  });
  assert.equal(secondRegistration.status, 201);
  const invitation = await request(baseUrl, "POST", "/api/workspaces/invitations", {}, registration.cookie);
  assert.equal(invitation.status, 201);
  const joinWorkspace = await request(baseUrl, "POST", "/api/workspaces/join", { code: invitation.data.code }, secondRegistration.cookie);
  assert.equal(joinWorkspace.status, 200);
  const sharedProjects = await request(baseUrl, "GET", "/api/projects", undefined, secondRegistration.cookie);
  assert.equal(sharedProjects.data.projects.some((project) => project.name === "Private launch"), true);
  const sharedTasks = await request(baseUrl, "GET", "/api/tasks", undefined, secondRegistration.cookie);
  assert.equal(sharedTasks.data.tasks.some((task) => task.title === "Ship the first milestone"), true);
  const secondWorkspaces = await request(baseUrl, "GET", "/api/workspaces", undefined, secondRegistration.cookie);
  assert.equal(secondWorkspaces.data.workspaces.length, 2);
  const privateWorkspace = secondWorkspaces.data.workspaces.find((workspace) => workspace.name === "Alex Lee's workspace");
  const switchedWorkspace = await request(baseUrl, "PATCH", "/api/workspaces/active", {
    workspace_id: privateWorkspace.id
  }, secondRegistration.cookie);
  assert.equal(switchedWorkspace.status, 200);
  const privateProjects = await request(baseUrl, "GET", "/api/projects", undefined, secondRegistration.cookie);
  assert.equal(privateProjects.data.projects.length, 3);
  assert.equal(privateProjects.data.projects.some((project) => project.name === "Private launch"), false);
  const sharedWorkspace = secondWorkspaces.data.workspaces.find((workspace) => workspace.id !== privateWorkspace.id);
  const returnToShared = await request(baseUrl, "PATCH", "/api/workspaces/active", {
    workspace_id: sharedWorkspace.id
  }, secondRegistration.cookie);
  assert.equal(returnToShared.status, 200);
  const teammateTask = await request(baseUrl, "POST", "/api/tasks", {
    title: "Teammate contribution",
    project_id: sharedProjects.data.projects.find((project) => project.name === "Website redesign").id,
    due_date: null,
    status: "In progress"
  }, secondRegistration.cookie);
  assert.equal(teammateTask.status, 201);
  const ownerSeesTask = await request(baseUrl, "GET", "/api/tasks", undefined, registration.cookie);
  assert.equal(ownerSeesTask.data.tasks.some((task) => task.title === "Teammate contribution"), true);

  const thirdRegistration = await request(baseUrl, "POST", "/api/auth/register", {
    name: "Casey Smith",
    email: "casey@example.com",
    password: "third-safe-password"
  });
  assert.equal(thirdRegistration.status, 201);
  const sharedProjectUpdate = await request(baseUrl, "PATCH", `/api/projects/${newProject.data.project.id}`, {
    category: "Shared product"
  }, secondRegistration.cookie);
  assert.equal(sharedProjectUpdate.status, 200);
  assert.equal(sharedProjectUpdate.data.project.category, "Shared product");
  const ownProjects = await request(baseUrl, "GET", "/api/projects", undefined, thirdRegistration.cookie);
  assert.equal(ownProjects.data.projects.length, 3);
  assert.equal(ownProjects.data.projects.some((project) => project.name === "Private launch"), false);

  await stopServer(server.child);
  server = await startServer(port, databasePath);
  const restoredSession = await request(server.baseUrl, "GET", "/api/auth/me", undefined, registration.cookie);
  assert.equal(restoredSession.status, 200);
  const restoredTasks = await request(server.baseUrl, "GET", "/api/tasks", undefined, registration.cookie);
  assert.equal(restoredTasks.data.tasks.some((task) => task.title === "Ship the first milestone" && task.completed), true);

  const deletedTask = await request(server.baseUrl, "DELETE", `/api/tasks/${newTask.data.task.id}`, undefined, registration.cookie);
  assert.equal(deletedTask.status, 200);
  const deletedProject = await request(server.baseUrl, "DELETE", `/api/projects/${newProject.data.project.id}`, undefined, registration.cookie);
  assert.equal(deletedProject.status, 200);
  const logout = await request(server.baseUrl, "POST", "/api/auth/logout", {}, registration.cookie);
  assert.equal(logout.status, 200);
  const unauthorized = await request(server.baseUrl, "GET", "/api/tasks", undefined, logout.cookie);
  assert.equal(unauthorized.status, 401);
});

test("existing single-user SQLite databases migrate into private workspaces", { timeout: 20_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "teamflow-migration-test-"));
  const databasePath = path.join(directory, "legacy.sqlite");
  const port = await freePort();
  const sessionToken = "legacy-browser-session-token";
  const email = "legacy@example.com";
  const passwordSalt = "0123456789abcdef";
  const passwordHash = crypto.scryptSync("legacy-safe-password", passwordSalt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  }).toString("hex");
  const legacyDb = new DatabaseSync(databasePath);
  legacyDb.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      color TEXT NOT NULL DEFAULT 'purple',
      deadline TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      due_date TEXT,
      status TEXT NOT NULL CHECK(status IN ('To do', 'In progress')),
      completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacyDb.prepare("INSERT INTO users (id, name, email, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)")
    .run("legacy-user", "Legacy User", email, passwordHash, passwordSalt);
  legacyDb.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(crypto.createHash("sha256").update(sessionToken).digest("hex"), "legacy-user", Date.now() + 60_000);
  legacyDb.prepare("INSERT INTO projects (id, user_id, name, category, color) VALUES (?, ?, ?, ?, ?)")
    .run("legacy-project", "legacy-user", "Saved project", "Design", "purple");
  legacyDb.prepare("INSERT INTO tasks (id, user_id, project_id, title, status) VALUES (?, ?, ?, ?, ?)")
    .run("legacy-task", "legacy-user", "legacy-project", "Saved task", "In progress");
  legacyDb.close();

  const server = await startServer(port, databasePath);
  t.after(async () => {
    await stopServer(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const cookie = `teamflow_session=${sessionToken}`;
  const account = await request(server.baseUrl, "GET", "/api/auth/me", undefined, cookie);
  assert.equal(account.status, 200);
  assert.equal(account.data.user.email, email);
  const projects = await request(server.baseUrl, "GET", "/api/projects", undefined, cookie);
  assert.equal(projects.data.projects.length, 1);
  assert.equal(projects.data.projects[0].name, "Saved project");
  const tasks = await request(server.baseUrl, "GET", "/api/tasks", undefined, cookie);
  assert.equal(tasks.data.tasks.length, 1);
  assert.equal(tasks.data.tasks[0].title, "Saved task");
});
